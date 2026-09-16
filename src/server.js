'use strict';

const express = require('express');
const config = require('./config');
const auth = require('./middleware/auth');
const tmpfiles = require('./lib/tmpfiles');
const healthRoutes = require('./routes/health');
const jobRoutes = require('./routes/jobs');

tmpfiles.reapAll();

const app = express();

app.use(healthRoutes); // no auth: CF health-check hits this

app.use(auth);
app.use(jobRoutes);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error('[pdf-compression-service] unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_error', message: 'Erreur interne inattendue.' });
});

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`pdf-compression-service listening on :${config.port} (authDisabled=${config.authDisabled})`);
});
