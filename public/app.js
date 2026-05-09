const form = document.getElementById('job-form');
const startButton = document.getElementById('start-button');
const jobStatus = document.getElementById('job-status');
const jobProgress = document.getElementById('job-progress');
const jobFailed = document.getElementById('job-failed');
const currentRow = document.getElementById('current-row');
const logOutput = document.getElementById('log-output');
const clearLogButton = document.getElementById('clear-log');
const downloadRow = document.getElementById('download-row');
const downloadLink = document.getElementById('download-link');

let activeJobId = null;
let pollTimer = null;

function setStatus(status) {
  jobStatus.textContent = status;
}

function renderLogs(logs) {
  logOutput.textContent = (logs || []).join('\n') || 'Ready.';
  logOutput.scrollTop = logOutput.scrollHeight;
}

function updateJobView(job) {
  setStatus(job.status);
  jobProgress.textContent = `${job.completedRows} / ${job.totalRows}`;
  jobFailed.textContent = String(job.failedRows);

  if (job.currentRow && job.currentRow.skill) {
    currentRow.textContent = `Row ${job.currentRow.rowNumber}: ${job.currentRow.skill}`;
  } else {
    currentRow.textContent = job.status === 'completed' ? 'Finished' : 'Not started';
  }

  renderLogs(job.logs);

  if (job.outputFileName) {
    downloadRow.hidden = false;
    downloadLink.href = `/api/jobs/${job.id}/output`;
  }

  if (job.status === 'failed' && job.error) {
    currentRow.textContent = job.error;
  }
}

async function pollJob(jobId) {
  const response = await fetch(`/api/jobs/${jobId}`);
  const job = await response.json();
  updateJobView(job);

  if (job.status === 'completed' || job.status === 'failed') {
    clearInterval(pollTimer);
    pollTimer = null;
    startButton.disabled = false;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  startButton.disabled = true;
  downloadRow.hidden = true;
  downloadLink.href = '#';
  setStatus('starting');
  currentRow.textContent = 'Preparing job';
  renderLogs(['Starting automation job...']);

  try {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      body: formData,
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'Unable to start automation job.');
    }

    activeJobId = payload.jobId;
    if (pollTimer) {
      clearInterval(pollTimer);
    }

    await pollJob(activeJobId);
    pollTimer = setInterval(() => pollJob(activeJobId), 2000);
  } catch (error) {
    startButton.disabled = false;
    setStatus('failed');
    currentRow.textContent = error.message;
    renderLogs([`Error: ${error.message}`]);
  }
});

clearLogButton.addEventListener('click', () => {
  renderLogs([]);
});
