const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { runAutomation } = require('./src/topinAutomation');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const OUTPUTS_DIR = path.join(ROOT_DIR, 'outputs');

for (const dir of [UPLOADS_DIR, OUTPUTS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const upload = multer({ dest: UPLOADS_DIR });
const jobs = new Map();

app.use(express.json());
app.use(express.static(path.join(ROOT_DIR, 'public')));

function appendLog(job, message) {
  const line = `[${new Date().toLocaleTimeString('en-IN', { hour12: true })}] ${message}`;
  job.logs.push(line);
  if (job.logs.length > 500) {
    job.logs = job.logs.slice(-500);
  }
  job.updatedAt = new Date().toISOString();
}

function buildPublicJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    totalRows: job.totalRows,
    completedRows: job.completedRows,
    failedRows: job.failedRows,
    currentRow: job.currentRow,
    outputFileName: job.outputFileName,
    error: job.error,
    logs: job.logs,
  };
}

app.post('/api/jobs', upload.single('csvFile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'CSV file is required.' });
  }

  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    totalRows: 0,
    completedRows: 0,
    failedRows: 0,
    currentRow: null,
    outputFileName: null,
    error: null,
    logs: [],
  };

  jobs.set(jobId, job);

  const options = {
    csvPath: req.file.path,
    mobileNumber: (req.body.mobileNumber || '').trim(),
    otp: (req.body.otp || '').trim(),
    headless: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_NAME ? true : req.body.showBrowser !== 'true',
    onLog: (message) => appendLog(job, message),
    onProgress: (progress) => {
      if (typeof progress.totalRows === 'number') job.totalRows = progress.totalRows;
      if (typeof progress.completedRows === 'number') job.completedRows = progress.completedRows;
      if (typeof progress.failedRows === 'number') job.failedRows = progress.failedRows;
      if (progress.currentRow) job.currentRow = progress.currentRow;
      job.updatedAt = new Date().toISOString();
    },
  };

  res.json({ jobId });

  try {
    job.status = 'running';
    appendLog(job, 'Automation job started.');
    const result = await runAutomation(options);
    job.status = 'completed';
    job.outputFileName = path.basename(result.outputCsvPath);
    job.totalRows = result.totalRows;
    job.completedRows = result.completedRows;
    job.failedRows = result.failedRows;
    job.currentRow = null;
    appendLog(job, `Automation completed. Output saved as ${job.outputFileName}.`);
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    job.currentRow = null;
    appendLog(job, `Automation failed: ${error.message}`);
  } finally {
    job.updatedAt = new Date().toISOString();
  }
});

app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  res.json(buildPublicJob(job));
});

app.get('/api/jobs/:jobId/output', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.outputFileName) {
    return res.status(404).json({ error: 'Output file not available.' });
  }

  const outputPath = path.join(OUTPUTS_DIR, job.outputFileName);
  if (!fs.existsSync(outputPath)) {
    return res.status(404).json({ error: 'Output file missing on disk.' });
  }

  res.download(outputPath, job.outputFileName);
});

app.get('/api/sample-csv', (req, res) => {
  res.download(path.join(ROOT_DIR, 'sample-input.csv'), 'sample-input.csv');
});

app.listen(PORT, () => {
  console.log(`Topin clone app running at http://localhost:${PORT}`);
});
