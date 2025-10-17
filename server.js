require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ---------------- Supabase Setup ----------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ---------------- PayU Credentials ----------------
const PAYU_KEY = process.env.PAYU_KEY;
const PAYU_SALT = process.env.PAYU_SALT;
const PAYU_BASE_URL = process.env.PAYU_BASE_URL;

// ---------------- CORS ----------------
app.use(
  cors({
    origin: ['http://localhost:4200',process.env.FRONTEND_URL],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ---------------- Debug Logs ----------------
app.use((req, res, next) => {
  console.log(`➡️ ${req.method} ${req.originalUrl}`);
  next();
});

// ---------------- Generate PayU Hash ----------------
function generateHash(params) {
  const hashString =
    [
      params.key,
      params.txnid,
      params.amount,
      params.productinfo,
      params.firstname,
      params.email,
      params.udf1 || '',
      params.udf2 || '',
      params.udf3 || '',
      params.udf4 || '',
      params.udf5 || '',
      '', '', '', '', '',
    ].join('|') + '|' + PAYU_SALT;

  return crypto.createHash('sha512').update(hashString).digest('hex');
}

// ---------------- Verify PayU Callback Hash ----------------
function verifyCallbackHash(paymentData) {
  try {
    const reverseHashString = [
      PAYU_SALT,
      paymentData.status || '',
      paymentData.udf5 || '',
      paymentData.udf4 || '',
      paymentData.udf3 || '',
      paymentData.udf2 || '',
      paymentData.udf1 || '',
      '', '', '', '', '',
      paymentData.email?.trim() || '',
      paymentData.firstname?.trim() || '',
      paymentData.productinfo?.trim() || '',
      parseFloat(paymentData.amount || '0').toFixed(2),
      paymentData.txnid?.trim() || '',
      paymentData.key || '',
    ].join('|');

    const expectedHash = crypto
      .createHash('sha512')
      .update(reverseHashString)
      .digest('hex');

    return expectedHash === paymentData.hash;
  } catch (err) {
    console.error('❌ Hash generation failed:', err);
    return false;
  }
}



// ---------------- Initiate Payment ----------------
app.post('/api/payu-initiate', async (req, res) => {
  try {
    const { personalInfo, course, amount } = req.body;

    const txnid = 'TXN' + Date.now();
    const finalAmount = amount || '1.00';

    // Insert a pending record for tracking
    const { error } = await supabase.from('applications').insert([
      {
        txnid,
        fullName: personalInfo.fullName,
        email: personalInfo.email,
        phone: personalInfo.phone,
        city: personalInfo.city,
        dob: personalInfo.dob,
        course,
        amount: finalAmount,
        status: 'pending',
      },
    ]);

    if (error) {
      console.error('❌ Supabase insert failed:', error);
      return res.status(500).json({ error: error.message });
    }

    // Prepare PayU parameters
    const payuParams = {
      key: PAYU_KEY,
      txnid,
      amount: finalAmount,
      firstname: personalInfo.fullName.trim(),
      email: personalInfo.email.trim(),
      phone: personalInfo.phone,
      productinfo: course.trim(),
      surl: `${process.env.BACKEND_URL}/api/payu-callback`,
      furl: `${process.env.BACKEND_URL}/api/payu-callback`,
      service_provider: 'payu_paisa',
      udf1: '',
      udf2: '',
      udf3: '',
      udf4: '',
      udf5: '',
    };

    // Generate the hash for PayU form
    payuParams.hash = generateHash(payuParams);

    // Return PayU form data to frontend
    res.json({ payuParams, payuUrl: PAYU_BASE_URL });
  } catch (err) {
    console.error('❌ PayU Initiate Error:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});



// ---------------- PayU Callback ----------------
app.post('/api/payu-callback', async (req, res) => {
  try {
    const paymentData = req.body;
    console.log('📥 PayU Callback RAW:', paymentData);

    const txnid = paymentData.txnid?.trim();
    if (!txnid) {
      console.error('❌ Callback missing txnid');
      return res.status(400).send('Missing txnid');
    }

    // ✅ Verify hash
    const hashValid = verifyCallbackHash(paymentData);
    if (!hashValid) {
      console.error('❌ Invalid hash detected:', paymentData.hash);
      return res.status(400).send('Invalid hash');
    }

    // ✅ Determine payment status
    let status = 'failure';
    if (paymentData.status === 'success') status = 'success';
    else if (paymentData.status === 'pending') status = 'pending';

    console.log(`🔄 Updating txn ${txnid} to status: ${status}`);

    // ✅ Update or insert (safe method without onConflict)
    const { data: existing } = await supabase
      .from('applications')
      .select('id')
      .eq('txnid', txnid)
      .maybeSingle();

    let error;

    if (existing) {
      ({ error } = await supabase
        .from('applications')
        .update({
          status,
          transactionid: txnid,
          rawresponse: JSON.stringify(paymentData),
          error_message:
            paymentData.error_Message || paymentData.error || null,
          amount: paymentData.amount,
        })
        .eq('txnid', txnid));
    } else {
      ({ error } = await supabase
        .from('applications')
        .insert([
          {
            txnid,
            status,
            transactionid: txnid,
            rawresponse: JSON.stringify(paymentData),
            error_message:
              paymentData.error_Message || paymentData.error || null,
            amount: paymentData.amount,
          },
        ]));
    }

    if (error) {
      console.error('❌ Supabase update/insert failed:', error);
      return res.status(500).send('Database update failed');
    }

    // ✅ Redirect based on status
    const redirectUrl =
      status === 'success'
        ? `${process.env.FRONTEND_URL}/payment-success?txnid=${txnid}`
        : `${process.env.FRONTEND_URL}/payment-failure?txnid=${txnid}`;

    console.log(`✅ Redirecting user to: ${redirectUrl}`);

    res.send(`
      <html>
        <head><meta http-equiv="refresh" content="1; url=${redirectUrl}" /></head>
        <body>Redirecting...</body>
      </html>
    `);
  } catch (err) {
    console.error('❌ Callback Exception:', err);
    res.status(500).send('Internal server error');
  }
});



// ---------------- Payment Details ----------------
app.get('/api/payment-details', async (req, res) => {
  try {
    const txnid = req.query.txnid?.replace(/\s+/g, '').trim();
    console.log('🔍 Checking payment details for:', txnid);

    if (!txnid) return res.status(400).json({ error: 'Missing txnid' });

    // ✅ Fetch all relevant columns
    let { data, error } = await supabase
      .from('applications')
      .select(`
        id,
        txnid,
        fullName,
        email,
        phone,
        city,
        heardFrom,
        dob,
        course,
        amount,
        status,
        transactionid,
        error_message,
        rawresponse
      `)
      .eq('txnid', txnid)
      .maybeSingle();

    console.log('📦 Supabase fetch result:', { data, error });

    if (error) throw error;

    // ✅ If no record found, create a pending placeholder
    if (!data) {
      console.log('🆕 No data found, inserting pending row...');
      const { data: newData, error: insertError } = await supabase
        .from('applications')
        .insert([{ txnid, status: 'pending' }])
        .select()
        .maybeSingle();

      if (insertError) throw insertError;
      data = newData;
    }

    // ✅ Send back full details
    res.json(data);
  } catch (err) {
    console.error('❌ Fetch Payment Details Error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});



// ---------------- Start Server ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend running at http://127.0.0.1:${PORT}`));
