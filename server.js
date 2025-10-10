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
  'https://oafnmnngahdxifwrheco.supabase.co', // Supabase URL
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9hZm5tbm5nYWhkeGlmd3JoZWNvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg3ODc4MjIsImV4cCI6MjA3NDM2MzgyMn0.2xG8SX2C5GsCVl6ySZCYkXL-2klfFKbvvBuRF7Y-dt0' // Supabase Service Role Key
);

// ---------------- PayU Credentials ----------------
const PAYU_KEY = 'Bb5MaO';
const PAYU_SALT = '7E9weTfAZZts8lfV91zV8vXfBhB5bPTn';
const PAYU_BASE_URL = 'https://test.payu.in/_payment'; // Change to secure.payu.in/_payment for LIVE

// ---------------- CORS ----------------
app.use(cors({
  origin: [
    'https://cruiselensacademy.com',
    'https://www.cruiselensacademy.com',
    'https://admin.cruiselensacademy.com'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Debug logging
app.use((req, res, next) => {
  console.log(`➡️ ${req.method} ${req.originalUrl}`);
  next();
});

// ---------------- Generate PayU Hash ----------------
function generateHash(params) {
  const hashString = [
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
    '', '', '', '', ''
  ].join('|') + '|' + PAYU_SALT;

  return crypto.createHash('sha512').update(hashString).digest('hex');
}

// ---------------- Verify PayU Callback Hash ----------------
function verifyCallbackHash(paymentData) {
  const reverseHashString = [
    PAYU_SALT,
    paymentData.status,
    paymentData.udf5 || '',
    paymentData.udf4 || '',
    paymentData.udf3 || '',
    paymentData.udf2 || '',
    paymentData.udf1 || '',
    '', '', '', '', '',
    paymentData.email?.trim() || '',
    paymentData.firstname?.trim() || '',
    paymentData.productinfo?.trim() || '',
    parseFloat(paymentData.amount).toFixed(2),
    paymentData.txnid,
    paymentData.key
  ].join('|');

  const expectedHash = crypto.createHash('sha512').update(reverseHashString).digest('hex');
  return expectedHash === paymentData.hash;
}

// ---------------- Initiate Payment ----------------
app.post('/api/payu-initiate', async (req, res) => {
  try {
    const { personalInfo, course, courseData, resumeFiles, paymentMode } = req.body;

    const txnid = 'TXN' + Date.now();
    let amount = "499.00";
    if (course === 'course1') amount = "50000.00";
    else if (course === 'course2') amount = "10000.00";

    // Save to Supabase
    const { error } = await supabase.from('applications').insert([{
      txnid,
      fullName: personalInfo.fullName,
      email: personalInfo.email,
      phone: personalInfo.phone,
      city: personalInfo.city,
      dob: personalInfo.dob,
      heardFrom: personalInfo.heardFrom,
      preferredContact: personalInfo.preferredContact,
      course,
      courseData,
      resume_urls: resumeFiles,
      paymentMode,
      status: 'pending'
    }]);

    if (error) return res.status(500).json({ error: error.message });

    // PayU params
    const payuParams = {
      key: PAYU_KEY,
      txnid,
      amount,
      firstname: personalInfo.fullName.trim(),
      email: personalInfo.email.trim(),
      phone: personalInfo.phone,
      productinfo: course.trim(),
      surl: 'https://cruiselensacademy.com/api/payu-callback',
      furl: 'https://cruiselensacademy.com/api/payu-callback',
      service_provider: 'payu_paisa',
      udf1: '', udf2: '', udf3: '', udf4: '', udf5: ''
    };

    payuParams.hash = generateHash(payuParams);
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
    console.log("📥 PayU Callback:", paymentData);

    if (!verifyCallbackHash(paymentData)) {
      return res.status(400).send('Invalid hash');
    }

    const { error } = await supabase.from('applications')
      .update({
        status: paymentData.status,
        transactionId: paymentData.txnid,
        rawResponse: JSON.stringify(paymentData)
      })
      .eq('txnid', paymentData.txnid);

    if (error) {
      console.error("❌ Supabase update error:", error.message);
      return res.status(500).send("DB update failed");
    }

    if (paymentData.status === 'success') {
      return res.redirect(`https://cruiselensacademy.com/payment-success?txnid=${paymentData.txnid}`);
    } else {
      return res.redirect(`https://cruiselensacademy.com/payment-failure?txnid=${paymentData.txnid}`);
    }

  } catch (err) {
    console.error('❌ Callback Error:', err);
    res.sendStatus(500);
  }
});

// ---------------- Start Server ----------------
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`✅ Backend running at http://${HOST}:${PORT}`);
});
