require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const db = require('./src/db');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api/auth', require('./src/routes/auth.routes')(db));
app.use('/api/warehouse', require('./src/routes/warehouse.routes')(db));
app.use('/api/analytics', require('./src/routes/analytics.routes')(db));

app.use(express.static(path.join(__dirname, 'public')));

// Basic error handler so a thrown error becomes JSON instead of an HTML stack trace.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`FinWare running at http://localhost:${PORT}`);
  console.log('Demo login: admin@finware.com / finware2026');
});
