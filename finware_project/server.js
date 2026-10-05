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
app.use('/api/insights', require('./src/routes/insights.routes')(db));

app.use(express.static(path.join(__dirname, 'public')));

// Error handler so a thrown error becomes JSON instead of an HTML stack trace.
// If the error already carries an HTTP status (e.g. body-parser's 400 for a
// malformed JSON body), respect it rather than flattening everything to 500.
// Stack traces and internal messages are never sent to the client.
app.use((err, req, res, next) => {
  const candidate = Number(err.statusCode || err.status || 500);
  const status = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: status >= 500 ? 'Something went wrong on the server.' : 'Bad request.'
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`FinWare running at http://localhost:${PORT}`);
  console.log('Demo login: admin@finware.com / finware2026');
});
