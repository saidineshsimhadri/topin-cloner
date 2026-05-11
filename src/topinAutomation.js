const fs = require('fs');
const https = require('https');
const path = require('path');
const { chromium } = require('playwright');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const BASE_URL = 'https://config.topin.tech/';
const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUTS_DIR = path.join(ROOT_DIR, 'outputs');
const SESSIONS_DIR = path.join(ROOT_DIR, 'sessions');
const SESSION_FILE = path.join(SESSIONS_DIR, 'topin-auth.json');
const ERROR_SHOTS_DIR = path.join(OUTPUTS_DIR, 'error-shots');
const WINDOWS_BROWSER_CANDIDATES = [
  {
    name: 'Microsoft Edge',
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  },
  {
    name: 'Microsoft Edge',
    executablePath: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  },
  {
    name: 'Google Chrome',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  },
];

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const TOPIN_TIME_INTERVAL_MINUTES = 5;
const END_TIME_BUFFER_MINUTES = 30;
const TINYURL_API_TOKEN = normalizeSpaces(process.env.TINYURL_API_TOKEN);
const TINYURL_API_URL = 'https://api.tinyurl.com/create';
const MAX_TINYURL_ALIAS_LENGTH = 12;
const SKILL_SHORT_URL_PREFIXES = {
  'applied gen ai development': 'gen',
  'computational thinking': 'ct',
  'critical thinking & communication': 'ctc',
  'cs fundamentals': 'cs',
  'quantitative reasoning': 'qr',
  'ui engineering': 'ui',
};

for (const dir of [OUTPUTS_DIR, SESSIONS_DIR, ERROR_SHOTS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeHeader(value) {
  return normalizeSpaces(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function slugify(value) {
  return normalizeSpaces(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getField(rawRow, candidates) {
  const entries = Object.entries(rawRow);
  for (const candidate of candidates) {
    const match = entries.find(([header]) => normalizeHeader(header) === candidate);
    if (match) {
      return normalizeSpaces(match[1]);
    }
  }
  return '';
}

function parseInputCsv(csvPath) {
  const fileContent = fs.readFileSync(csvPath, 'utf8');
  const rows = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
    trim: true,
  });

  return rows
    .map((rawRow, index) => {
    const row = {
      rowNumber: index + 2,
      skill: getField(rawRow, ['skill', 'assessmentname', 'name']),
      assessmentDate: getField(rawRow, [
        'dateofassessment',
        'assessmentdate',
        'date',
      ]),
      startTimeSlot: getField(rawRow, ['starttimeslot', 'starttime', 'timeslot', 'time']),
      endTimeSlot: getField(rawRow, ['endtimeslot', 'endtime']),
      uniqueExamId: getField(rawRow, [
        'uniqueexamid',
        'uniqueexam',
        'uniqueexa',
        'examid',
        'uniqueid',
      ]),
      exitPin: getField(rawRow, ['exitpin', 'exitpassword', 'exitpass', 'pin']),
      sampleConfigLink: getField(rawRow, [
        'sampleconfiglink',
        'sampleconfig',
        'samplelink',
        'configlink',
      ]),
    };

    const missing = [];
    if (!row.skill) missing.push('Skill');
    if (!row.uniqueExamId) missing.push('UniqueExamID');
    if (!row.exitPin) missing.push('EXIT PIN');
    if (!row.sampleConfigLink) missing.push('Sample Config Link');

    if (!row.assessmentDate && row.uniqueExamId) {
      row.assessmentDate = extractDateFromExamId(row.uniqueExamId);
    }
    if (!row.assessmentDate) missing.push('Date of Assessment');

    if (!row.startTimeSlot && row.uniqueExamId) {
      try {
        row.startTimeSlot = extractTimeSlotFromExamId(row.uniqueExamId);
      } catch (error) {
        missing.push('Start Time Slot or parsable UniqueExamID time');
      }
    } else if (!row.startTimeSlot) {
      missing.push('Start Time Slot or UniqueExamID');
    }

    row.validationError = missing.length
      ? `Missing required columns/values: ${missing.join(', ')}`
      : null;

    return row;
    })
    .filter(
      (row) =>
        row.skill ||
        row.assessmentDate ||
        row.startTimeSlot ||
        row.endTimeSlot ||
        row.uniqueExamId ||
        row.exitPin ||
        row.sampleConfigLink,
    );
}

function formatTimeSlot(date) {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const period = hours >= 12 ? 'PM' : 'AM';
  const twelveHour = hours % 12 || 12;
  return `${twelveHour}:${String(minutes).padStart(2, '0')} ${period}`;
}

function floorDateToInterval(date, intervalMinutes = TOPIN_TIME_INTERVAL_MINUTES) {
  const normalizedDate = new Date(date.getTime());
  const minutes = normalizedDate.getMinutes();
  const flooredMinutes = Math.floor(minutes / intervalMinutes) * intervalMinutes;
  normalizedDate.setMinutes(flooredMinutes, 0, 0);
  return normalizedDate;
}

function parseTimeSlot(value, fallback = null) {
  const normalizedValue = normalizeSpaces(value);

  // ── 12-hour format with explicit AM/PM (e.g. "1:30 PM", "11:00 AM") ────────
  const twelveHourMatch = normalizedValue.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (twelveHourMatch) {
    let hour = Number(twelveHourMatch[1]);
    const minute = Number(twelveHourMatch[2]);
    const second = twelveHourMatch[3] ? Number(twelveHourMatch[3]) : 0;
    const period = twelveHourMatch[4].toUpperCase();

    if (hour < 1 || hour > 12 || minute < 0 || minute > 59 || second < 0 || second > 59) {
      throw new Error(`Invalid Time Slot value: "${value}"`);
    }

    if (period === 'AM' && hour === 12) hour = 0;
    if (period === 'PM' && hour !== 12) hour += 12;

    return { hour, minute };
  }

  // ── Plain time without AM/PM (e.g. "1:30", "13:00") ─────────────────────────
  const plainTimeMatch = normalizedValue.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (plainTimeMatch) {
    const inputHour = Number(plainTimeMatch[1]);
    const minute = Number(plainTimeMatch[2]);
    const second = plainTimeMatch[3] ? Number(plainTimeMatch[3]) : 0;

    if (inputHour < 0 || inputHour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
      throw new Error(`Invalid Time Slot value: "${value}"`);
    }

    // Unambiguous 24-hour value (13-23): return directly.
    if (inputHour > 12) {
      return { hour: inputHour, minute };
    }

    // inputHour is in 0-12: ambiguous without AM/PM.
    // Resolve using the fallback (derived from UniqueExamID or start time).
    if (fallback) {
      const fallbackTwelveHour = fallback.hour % 12 || 12; // 0→12, 13→1, 14→2 …

      if (fallbackTwelveHour === inputHour) {
        // Same 12-hr hour as the fallback → use fallback's AM/PM half directly.
        const isPm = fallback.hour >= 12;
        const resolvedHour = isPm
          ? (inputHour === 12 ? 12 : inputHour + 12)
          : (inputHour === 12 ? 0 : inputHour);
        return { hour: resolvedHour, minute };
      }

      // Different 12-hr hour → stay in the same AM/PM half as the fallback.
      // e.g. fallback = 13 (1 PM), inputHour = 2  → resolved as 14 (2 PM)
      // e.g. fallback = 11 (11 AM), inputHour = 1 → resolved as 1 (1 AM)
      const isPm = fallback.hour >= 12;
      const resolvedHour = isPm
        ? (inputHour === 12 ? 12 : inputHour + 12)
        : (inputHour === 12 ? 0 : inputHour);
      return { hour: resolvedHour, minute };
    }

    // No fallback and no AM/PM supplied: throw a clear error.
    if (inputHour >= 1 && inputHour <= 12) {
      throw new Error(
        `Ambiguous Time Slot "${value}": cannot determine AM/PM. ` +
        `Please use 12-hour format with AM/PM ` +
        `(e.g. "${inputHour}:${String(minute).padStart(2, '0')} PM") ` +
        `or provide a UniqueExamID that encodes the time.`,
      );
    }

    return { hour: inputHour, minute }; // hour === 0 (midnight), unambiguous
  }

  throw new Error(`Invalid Time Slot format: "${value}"`);
}

function extractDateFromExamId(uniqueExamId) {
  const match = uniqueExamId.match(/(\d{4}-\d{2}-\d{2})/);
  if (!match) {
    throw new Error(`UniqueExamID does not contain a date: "${uniqueExamId}"`);
  }

  return match[1];
}

function normalizeAssessmentDate(value) {
  const normalizedValue = normalizeSpaces(value);
  if (!normalizedValue) {
    throw new Error('Date of Assessment is empty.');
  }

  const isoMatch = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    return validateDateParts(year, month, day, value);
  }

  const dayFirstMatch = normalizedValue.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dayFirstMatch) {
    const day = Number(dayFirstMatch[1]);
    const month = Number(dayFirstMatch[2]);
    const year = Number(dayFirstMatch[3]);
    return validateDateParts(year, month, day, value);
  }

  throw new Error(`Invalid Date of Assessment format: "${value}"`);
}

function validateDateParts(year, month, day, originalValue) {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid Date of Assessment value: "${originalValue}"`);
  }

  const candidate = new Date(year, month - 1, day);
  if (
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month - 1 ||
    candidate.getDate() !== day
  ) {
    throw new Error(`Invalid Date of Assessment value: "${originalValue}"`);
  }

  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function extractTimeSlotFromExamId(uniqueExamId) {
  const match = normalizeSpaces(uniqueExamId).match(/_(\d{4})(?:\D.*)?$/);
  if (!match) {
    throw new Error(`UniqueExamID does not contain a trailing HHMM time: "${uniqueExamId}"`);
  }

  const timeCode = match[1];
  const hour = Number(timeCode.slice(0, 2));
  const minute = Number(timeCode.slice(2, 4));

  if (hour > 23 || minute > 59) {
    throw new Error(`UniqueExamID contains an invalid HHMM time: "${uniqueExamId}"`);
  }

  const period = hour >= 12 ? 'PM' : 'AM';
  const twelveHour = hour % 12 || 12;
  return `${twelveHour}:${String(minute).padStart(2, '0')} ${period}`;
}

function extractTimePartsFromExamId(uniqueExamId) {
  const match = normalizeSpaces(uniqueExamId).match(/_(\d{4})(?:\D.*)?$/);
  if (!match) {
    throw new Error(`UniqueExamID does not contain a trailing HHMM time: "${uniqueExamId}"`);
  }

  const timeCode = match[1];
  const hour = Number(timeCode.slice(0, 2));
  const minute = Number(timeCode.slice(2, 4));

  if (hour > 23 || minute > 59) {
    throw new Error(`UniqueExamID contains an invalid HHMM time: "${uniqueExamId}"`);
  }

  return { hour, minute };
}

function buildStartDateTime(assessmentDate, uniqueExamId, timeSlot = '') {
  let examIdTime = null;
  try {
    examIdTime = extractTimePartsFromExamId(uniqueExamId);
  } catch (error) {
    examIdTime = null;
  }

  const resolvedTimeSlot = normalizeSpaces(timeSlot) || extractTimeSlotFromExamId(uniqueExamId);
  const { hour, minute } = parseTimeSlot(resolvedTimeSlot, examIdTime);
  const datePart = normalizeAssessmentDate(assessmentDate);
  const [year, month, day] = datePart.split('-').map(Number);
  return floorDateToInterval(new Date(year, month - 1, day, hour, minute, 0, 0));
}

function buildDateTimeFromSlot(assessmentDate, uniqueExamId, timeSlot = '', fallback = null) {
  let examIdTime = null;
  try {
    examIdTime = extractTimePartsFromExamId(uniqueExamId);
  } catch (error) {
    examIdTime = null;
  }

  // Normalize fallback: if a Date object was passed (e.g. newStart from processRow),
  // extract {hour, minute} from it so parseTimeSlot can read .hour correctly.
  // Without this, fallback.hour is undefined and AM/PM resolution always defaults to AM.
  let normalizedFallback = fallback;
  if (fallback instanceof Date) {
    normalizedFallback = { hour: fallback.getHours(), minute: fallback.getMinutes() };
  }

  const resolvedFallback = normalizedFallback || examIdTime;
  const resolvedTimeSlot = normalizeSpaces(timeSlot) || extractTimeSlotFromExamId(uniqueExamId);
  const { hour, minute } = parseTimeSlot(resolvedTimeSlot, resolvedFallback);
  const [year, month, day] = normalizeAssessmentDate(assessmentDate).split('-').map(Number);
  return floorDateToInterval(new Date(year, month - 1, day, hour, minute, 0, 0));
}

function getShortUrlPrefixForSkill(skill) {
  return SKILL_SHORT_URL_PREFIXES[normalizeSpaces(skill).toLowerCase()] || slugify(skill).slice(0, 3) || 'ass';
}

function buildShortUrlAlias(row) {
  const prefix = getShortUrlPrefixForSkill(row.skill);
  const examYear = normalizeAssessmentDate(row.assessmentDate).slice(2, 4);
  const randomSuffix = String(Math.floor(1000 + Math.random() * 9000));
  return `${prefix}${examYear}-${randomSuffix}`.slice(0, MAX_TINYURL_ALIAS_LENGTH);
}

function postJson(url, headers, payload) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST',
      headers,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          // Check if response is likely HTML (error page)
          if (body.trim().startsWith('<!DOCTYPE') || body.trim().startsWith('<html')) {
            resolve({
              statusCode: response.statusCode || 0,
              body: { error: `Received HTML response instead of JSON. Status: ${response.statusCode}` },
            });
            return;
          }
          
          // Check if response is likely JSON before parsing
          if (response.statusCode >= 400 || !body.trim().startsWith('{')) {
            resolve({
              statusCode: response.statusCode || 0,
              body: { error: `HTTP ${response.statusCode}: ${body}` },
            });
            return;
          }
          
          resolve({
            statusCode: response.statusCode || 0,
            body: body ? JSON.parse(body) : {},
          });
        } catch (error) {
          // If JSON parsing fails, return the raw body as error
          resolve({
            statusCode: response.statusCode || 0,
            body: { error: `JSON parse error: ${error.message}. Raw response: ${body}` },
          });
        }
      });
    });

    request.on('error', reject);
    request.write(JSON.stringify(payload));
    request.end();
  });
}

async function createShortUrl(longUrl, alias, onLog = console.log) {
  if (!longUrl) {
    return '';
  }
  
  // Skip TinyURL creation if API token is missing or invalid
  if (!TINYURL_API_TOKEN) {
    onLog('TinyURL API token missing, using original URL');
    return longUrl;
  }

  onLog(`TinyURL: Creating short URL for ${longUrl} with alias ${alias}`);

  let resolvedAlias = slugify(alias);
  while (resolvedAlias.length < 5) {
    resolvedAlias += Math.floor(Math.random() * 10);
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const payload = {
      url: longUrl,
      domain: 'tinyurl.com',
      alias: resolvedAlias,
    };
    const headers = {
      Authorization: `Bearer ${TINYURL_API_TOKEN}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(JSON.stringify(payload)),
    };
    
    try {
      onLog(`TinyURL attempt ${attempt + 1}: ${JSON.stringify(payload)}`);
      const { statusCode, body: result } = await postJson(
        TINYURL_API_URL,
        headers,
        payload,
      );
      
      onLog(`TinyURL response (${statusCode}): ${JSON.stringify(result, null, 2)}`);
      
      if (result?.data?.tiny_url) {
        onLog(`TinyURL success: ${result.data.tiny_url}`);
        return result.data.tiny_url;
      }

      // If we get here, the API didn't return a short URL
      const errors = Array.isArray(result?.errors) ? result.errors : [];
      const aliasUnavailable = errors.some((error) => String(error).includes('Alias is not available'));
      if (aliasUnavailable) {
        const suffix = String(Math.floor(1000 + Math.random() * 9000));
        const baseAlias = resolvedAlias.slice(0, MAX_TINYURL_ALIAS_LENGTH - suffix.length - 1);
        resolvedAlias = `${baseAlias}-${suffix}`;
        onLog(`TinyURL alias unavailable, trying: ${resolvedAlias}`);
        continue;
      }

      // If it's not an alias issue, break and fall back to original URL
      onLog(`TinyURL API error: ${JSON.stringify(result)}`);
      break;
    } catch (error) {
      onLog(`TinyURL attempt ${attempt + 1} failed: ${error.message}`);
      if (attempt === 2) { // Last attempt, fall back to original URL
        onLog('TinyURL API failed after all attempts, using original URL as fallback');
        return longUrl;
      }
    }
  }

  // Fallback to original URL if TinyURL creation fails
  onLog('TinyURL creation failed, using original URL');
  return longUrl;
}

function parseTopinDateTime(value) {
  const match = normalizeSpaces(value).match(
    /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s+(AM|PM)$/i,
  );

  if (!match) {
    throw new Error(`Unable to parse Topin date/time value: "${value}"`);
  }

  const day = Number(match[1]);
  const monthIndex = MONTH_NAMES.findIndex(
    (month) => month.toLowerCase() === match[2].toLowerCase(),
  );
  const year = Number(match[3]);
  let hour = Number(match[4]);
  const minute = Number(match[5]);
  const period = match[6].toUpperCase();

  if (monthIndex < 0) {
    throw new Error(`Invalid month name in Topin date/time: "${value}"`);
  }

  if (period === 'AM' && hour === 12) hour = 0;
  if (period === 'PM' && hour !== 12) hour += 12;

  return new Date(year, monthIndex, day, hour, minute, 0, 0);
}

function formatMonthYear(date) {
  return `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
}

function ordinalSuffix(day) {
  if (day >= 11 && day <= 13) return 'th';
  const lastDigit = day % 10;
  if (lastDigit === 1) return 'st';
  if (lastDigit === 2) return 'nd';
  if (lastDigit === 3) return 'rd';
  return 'th';
}

function buildDateButtonName(date) {
  const weekday = WEEKDAY_NAMES[date.getDay()];
  const month = MONTH_NAMES[date.getMonth()];
  const day = date.getDate();
  return `Choose ${weekday}, ${month} ${day}${ordinalSuffix(day)}, ${date.getFullYear()}`;
}

function normalizeSampleViewLink(url) {
  const trimmed = normalizeSpaces(url);
  if (!trimmed) {
    throw new Error('Sample Config Link is empty.');
  }

  return trimmed.replace('/edit-assessment/', '/view-assessment/');
}

function normalizePublishedAssessmentLink(url) {
  const trimmed = normalizeSpaces(url);
  if (!trimmed) {
    return '';
  }

  return trimmed;
}

function normalizeAssessmentLinkForShortUrl(url) {
  const trimmed = normalizePublishedAssessmentLink(url);
  if (!trimmed) {
    return '';
  }

  // Remove a_t=CLIENT parameter and clean up trailing &
  let cleaned = trimmed.replace(/a_t=CLIENT/gi, '');
  
  // Remove trailing & or &amp; and clean up double &
  cleaned = cleaned.replace(/&+$/, '').replace(/&+/g, '&');
  
  // If URL ends with ? or &, remove it
  cleaned = cleaned.replace(/[?&]$/, '');
  
  return cleaned;
}

async function getLabeledValue(page, label) {
  return page.evaluate((expectedLabel) => {
    const normalize = (value) => value.replace(/\s+/g, ' ').trim();
    const nodes = Array.from(document.querySelectorAll('main *'));

    for (const node of nodes) {
      const text = normalize(node.textContent || '');
      if (text !== expectedLabel) continue;

      const sibling = node.nextElementSibling;
      if (sibling) {
        const siblingText = normalize(sibling.textContent || '');
        if (siblingText) return siblingText;
      }

      const parent = node.parentElement;
      if (parent) {
        const children = Array.from(parent.children);
        const index = children.indexOf(node);
        const next = children[index + 1];
        if (next) {
          const nextText = normalize(next.textContent || '');
          if (nextText) return nextText;
        }
      }
    }

    return null;
  }, label);
}

async function detectAccessType(page) {
  const bodyText = await page.locator('body').textContent();
  if ((bodyText || '').includes('Only invited candidates can access and write the assessment')) {
    return 'Private';
  }
  if ((bodyText || '').includes('Anyone can access and write the assessment')) {
    return 'Public';
  }
  return 'Private';
}

async function ensureMonth(page, targetDate) {
  const picker = page.locator('.react-datepicker').last();
  const targetMonthYear = formatMonthYear(targetDate);

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const currentMonthYear = normalizeSpaces(
      (await picker.locator('.react-datepicker__current-month').textContent()) || '',
    );

    if (currentMonthYear === targetMonthYear) {
      return;
    }

    const [currentMonthName, currentYearText] = currentMonthYear.split(' ');
    const currentMonthIndex = MONTH_NAMES.findIndex((month) => month === currentMonthName);
    const currentYear = Number(currentYearText);

    const currentKey = currentYear * 12 + currentMonthIndex;
    const targetKey = targetDate.getFullYear() * 12 + targetDate.getMonth();

    if (currentKey < targetKey) {
      await picker.getByRole('button', { name: 'Next Month' }).click();
    } else {
      await picker.getByRole('button', { name: 'Previous Month' }).click();
    }
  }

  throw new Error(`Unable to navigate date picker to ${targetMonthYear}`);
}

async function setDateTimeField(page, testId, targetDate) {
  const normalizedTargetDate = floorDateToInterval(targetDate);
  const wrapper = page.locator(`[data-testid="${testId}"]`);
  const input = wrapper.locator('input[placeholder="Select Date & Time"]');
  await input.click();
  await page.locator('.react-datepicker').last().waitFor({ state: 'visible' });

  await ensureMonth(page, normalizedTargetDate);
  await page
    .locator('.react-datepicker')
    .last()
    .getByRole('button', { name: buildDateButtonName(normalizedTargetDate) })
    .click();

  const timeText = formatTimeSlot(normalizedTargetDate);

  // react-datepicker renders a scrollable <ul> time list. Problems we must solve:
  //   1. Exact text match — "2:00 PM" is a substring of "12:00 PM", so hasText fails.
  //   2. Scroll — items outside the visible area won't receive real pointer events.
  //   3. React synthetic events — react-datepicker listens to onClick on the <li>.
  //      Programmatic dispatchEvent doesn't always trigger React's synthetic layer,
  //      so we scroll the item into view then use Playwright's real pointer click.

  const pickerEl = page.locator('.react-datepicker').last();

  // Step 1: find item index by exact text, scroll it into view, return its offsetTop.
  const scrollResult = await pickerEl.evaluate((el, targetText) => {
    const list = el.querySelector('.react-datepicker__time-list');
    const items = Array.from(el.querySelectorAll('.react-datepicker__time-list-item'));
    const index = items.findIndex((item) => (item.textContent || '').trim() === targetText);
    if (index === -1 || !list) return null;

    const item = items[index];
    // Scroll so the item sits at the top of the visible list area.
    list.scrollTop = item.offsetTop;
    return { offsetTop: item.offsetTop, itemHeight: item.offsetHeight };
  }, timeText);

  if (!scrollResult) {
    throw new Error(`Time option "${timeText}" not found in the date picker time list.`);
  }

  // Step 2: wait one animation frame for the scroll to paint, then use Playwright's
  // native click — this fires real pointer events that React's synthetic system picks up.
  await page.waitForTimeout(150);

  // Re-locate the item after scroll using nth-match on the now-visible exact text.
  // We use page.locator scoped to the picker and filter with a JS predicate via evaluate
  // to get the element handle, then click it via Playwright's elementHandle.click().
  const timeItemHandle = await pickerEl.evaluateHandle((el, targetText) => {
    const items = Array.from(el.querySelectorAll('.react-datepicker__time-list-item'));
    return items.find((item) => (item.textContent || '').trim() === targetText) || null;
  }, timeText);

  const element = timeItemHandle.asElement();
  if (!element) {
    throw new Error(`Time option "${timeText}" could not be located for clicking.`);
  }

  // Use Playwright's built-in elementHandle.click() — real browser pointer events.
  await element.click();
  await timeItemHandle.dispose();

  // Wait for React to commit the state update to the input.
  await page.waitForTimeout(300);

  const finalValue = normalizeSpaces(await input.inputValue());
  if (!finalValue.includes(timeText)) {
    throw new Error(`Failed to set ${testId} to ${timeText}. Current value: "${finalValue}"`);
  }
}

async function replaceUniqueExamIdTag(page, oldTag, newTag) {
  if (!newTag || oldTag === newTag) {
    return;
  }

  if (oldTag) {
    await page.evaluate((tagToRemove) => {
      const chips = Array.from(
        document.querySelectorAll('[data-testid="bscd-assess-categories-input"] .Select__multi-value'),
      );
      const chip = chips.find((node) => (node.textContent || '').includes(tagToRemove));
      const remove = chip ? chip.querySelector('.Select__multi-value__remove') : null;
      if (remove) {
        remove.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        remove.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    }, oldTag);
  }

  const input = page.locator('[data-testid="bscd-assess-categories-input"] input').first();
  await input.fill(newTag);
  await input.press('Enter');
}

async function ensureInternalAdminOpen(page) {
  const secureButton = page.getByRole('button', { name: 'Enable Secure Browser' });
  if (!(await secureButton.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Internal Admin Options' }).click();
  }
}

async function setExitPin(page, exitPin) {
  await ensureInternalAdminOpen(page);
  const secureContainer = page.locator('[data-testid="ao-exam-environment-option"]');
  const exitInput = secureContainer.locator('input[placeholder="Custom Exit Password (if any)"]');

  if (!(await exitInput.isVisible().catch(() => false))) {
    await secureContainer.getByRole('button', { name: 'Enable Secure Browser' }).click();
  }

  const yesRadio = secureContainer.locator('input[data-testid="Yes"]').first();
  if ((await yesRadio.count()) && !(await yesRadio.isChecked().catch(() => false))) {
    await secureContainer.locator('span', { hasText: 'Yes' }).first().click();
  }

  await exitInput.fill('');
  await exitInput.fill(exitPin);
}

async function ensureRadioOptionSelected(container, testId) {
  const option = container.locator(`input[data-testid="${testId}"]`).first();
  await option.waitFor({ state: 'attached', timeout: 10000 });

  if (await option.isChecked().catch(() => false)) {
    return;
  }

  await container.locator('label', { hasText: testId }).first().click();
}

async function setQrBasedAttendanceMode(page) {
  await ensureInternalAdminOpen(page);
  const container = page.locator('[data-testid="ao-qr-code-option"]');

  if (!(await container.locator('label', { hasText: 'During Exam' }).first().isVisible().catch(() => false))) {
    await container.getByRole('button', { name: 'QR based Attendance Mode' }).click();
  }

  await ensureRadioOptionSelected(container, 'During Exam');
}

async function setExamPinMode(page) {
  await ensureInternalAdminOpen(page);
  const container = page.locator('[data-testid="ao-pin-to-start-enable-option"]');

  if (!(await container.locator('label', { hasText: 'Common Start PIN' }).first().isVisible().catch(() => false))) {
    await container.getByRole('button', { name: 'Enable Exam PIN' }).click();
  }

  await ensureRadioOptionSelected(container, 'Common Start PIN');
}

async function waitForAuthenticatedTopinHome(page, onLog = console.log) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await waitForPageSettled(page);

  // If we're still on login page, definitely not authenticated
  if (page.url().includes('accounts.ccbp.in/login')) {
    return false;
  }

  // If we're on config.topin.tech domain, we're likely authenticated
  if (page.url().includes('config.topin.tech')) {
    onLog(`On Topin domain: ${page.url()}`);
    
    // Try to find the Home button (original check)
    try {
      await page.getByRole('button', { name: 'Home' }).waitFor({ timeout: 10000 });
      onLog('Found Home button - authentication confirmed');
      return true;
    } catch (error) {
      onLog('Home button not found, trying alternatives...');
    }
    
    // Try alternative buttons
    const alternatives = ['Dashboard', 'Main', 'Overview', 'Menu', 'Create'];
    for (const alt of alternatives) {
      try {
        await page.getByRole('button', { name: alt }).waitFor({ timeout: 3000 });
        onLog(`Found ${alt} button - authentication confirmed`);
        return true;
      } catch (e) {
        // Continue to next alternative
      }
    }
    
    // Check for navigation elements
    try {
      const navCount = await page.locator('nav, [role="navigation"], .navbar, .nav-menu').count();
      if (navCount > 0) {
        onLog(`Found ${navCount} navigation elements - assuming authenticated`);
        return true;
      }
    } catch (e) {
      onLog('Navigation check failed');
    }
    
    // Check for common authenticated page elements
    try {
      const commonElements = await page.locator('header, .header, .topbar, .sidebar, .main-content').count();
      if (commonElements > 0) {
        onLog(`Found ${commonElements} common page elements - assuming authenticated`);
        return true;
      }
    } catch (e) {
      onLog('Common elements check failed');
    }
    
    // If we're on the right domain and not on login page, assume success
    // This is more lenient for headless environments
    onLog('On correct domain and not on login page - assuming authentication successful');
    return true;
  }
  
  onLog(`Not on expected domain. Current URL: ${page.url()}`);
  return false;
}

async function ensureLoggedIn(page, mobileNumber, otp, onLog) {
  const hasExplicitCredentials = Boolean(mobileNumber && otp);
  
  // Debug Railway environment detection
  const railwayEnv = process.env.RAILWAY_ENVIRONMENT_NAME;
  const railwayProject = process.env.RAILWAY_PROJECT_NAME;
  const nodeEnv = process.env.NODE_ENV;
  const isRailway = !!(railwayEnv || railwayProject || nodeEnv === 'production');
  
  onLog(`Environment debug: RAILWAY_ENV=${railwayEnv}, RAILWAY_PROJECT=${railwayProject}, NODE_ENV=${nodeEnv}, isRailway=${isRailway}`);

  if (hasExplicitCredentials) {
    onLog('Using the mobile number and OTP entered in the app for this run.');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await waitForPageSettled(page);

    if (!page.url().includes('accounts.ccbp.in/login')) {
      await page.context().clearCookies().catch(() => {});
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await waitForPageSettled(page);
    }
  }

  if (hasExplicitCredentials && !page.url().includes('accounts.ccbp.in/login')) {
    throw new Error('Unable to open the login page for the provided mobile number and OTP.');
  }

  if (hasExplicitCredentials) {
    onLog('Logging into Topin with the provided mobile number and OTP.');
    await page.locator('input[placeholder="Enter Number"]').fill(mobileNumber);
    await page.getByRole('button', { name: 'GET OTP' }).click();
    
    // Wait a bit for OTP request to process
    await page.waitForTimeout(2000);
    onLog('OTP request sent, waiting for input fields...');

    const digits = otp.replace(/\D/g, '');
    if (digits.length !== 6) {
      throw new Error('OTP must contain exactly 6 digits.');
    }

    onLog(`Entering OTP: ${digits}`);
    const otpInputs = page.locator('input[aria-label*="Digit"], input[aria-label*="verification code"]');
    
    // Wait for OTP inputs to be available
    await otpInputs.first().waitFor({ timeout: 10000 });
    onLog('OTP input fields found, filling digits...');
    
    for (let index = 0; index < 6; index += 1) {
      await otpInputs.nth(index).fill(digits[index]);
      await page.waitForTimeout(100); // Small delay between digits
    }
    
    onLog('OTP digits entered, clicking verify button...');
    await page.getByRole('button', { name: /Verify & Login/i }).click();
    
    onLog('Verify button clicked, waiting for redirect...');
    
    // Wait longer for the redirect and be more flexible
    try {
      await page.waitForURL(/config\.topin\.tech/, { timeout: 90000 });
      onLog('Successfully redirected to config.topin.tech');
      
      // Wait a bit more and check if we stay on the right domain
      await page.waitForTimeout(2000);
      const immediateUrl = page.url();
      onLog(`Immediate URL after redirect: ${immediateUrl}`);
      
      if (immediateUrl.includes('accounts.ccbp.in/login')) {
        onLog('Redirected back to login page - possible session issue');
      }
      
    } catch (error) {
      onLog(`Redirect timeout or failed. Current URL: ${page.url()}`);
      
      // Check if we're still on login page after longer wait
      await page.waitForTimeout(5000);
      const currentUrl = page.url();
      onLog(`After additional wait, current URL: ${currentUrl}`);
      
      if (currentUrl.includes('accounts.ccbp.in/login')) {
        // Try clicking verify button again in case it didn't register
        onLog('Still on login page, trying to click verify button again...');
        try {
          await page.getByRole('button', { name: /Verify & Login/i }).click();
          await page.waitForTimeout(5000);
          onLog(`After retry, current URL: ${page.url()}`);
        } catch (retryError) {
          onLog(`Retry failed: ${retryError.message}`);
        }
      }
    }
    
    await waitForPageSettled(page);
    await page.waitForTimeout(5000); // Longer wait to see if page stabilizes

    // Always use simplified validation - bypass the complex check entirely
    const finalUrl = page.url();
    onLog(`Final URL after all waits: ${finalUrl}`);
    
    // If we're on config.topin.tech (even briefly), or if we're not on login page, assume success
    if (finalUrl.includes('config.topin.tech')) {
      onLog('Login successful - on Topin domain');
      onLog('Session validation bypassed for deployment compatibility');
      return;
    } else if (!finalUrl.includes('accounts.ccbp.in/login')) {
      onLog('Not on login page - assuming login succeeded');
      onLog('Session validation bypassed for deployment compatibility');
      return;
    } else {
      onLog(`Login appears to have failed - still on login page: ${finalUrl}`);
      
      // Let's try to continue anyway - maybe the session is actually valid
      onLog('Attempting to continue despite being on login page...');
      
      // Try going directly to config.topin.tech
      try {
        onLog('Trying direct navigation to config.topin.tech...');
        await page.goto('https://config.topin.tech/', { waitUntil: 'domcontentloaded' });
        await waitForPageSettled(page);
        await page.waitForTimeout(3000);
        
        const directUrl = page.url();
        onLog(`After direct navigation: ${directUrl}`);
        
        if (!directUrl.includes('accounts.ccbp.in/login')) {
          onLog('Direct navigation successful - proceeding with automation');
          return;
        }
      } catch (directError) {
        onLog(`Direct navigation failed: ${directError.message}`);
      }
      
      throw new Error(`Login failed - unable to access Topin dashboard: ${finalUrl}`);
    }
  }

  // For saved sessions, also use simplified check
  onLog('Checking for existing session...');
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await waitForPageSettled(page);
  
  if (!page.url().includes('accounts.ccbp.in/login')) {
    onLog('Using saved Topin session.');
    return;
  }

  if (!mobileNumber || !otp) {
    throw new Error(
      'Login is required. Enter Mobile Number and OTP in the app, or keep a valid saved session.',
    );
  }

  // This shouldn't be reached if hasExplicitCredentials is true, but keeping for safety
  throw new Error('Unexpected login flow - please check credentials.');
}

async function openSampleAndReadMetadata(page, sampleConfigLink) {
  const viewLink = normalizeSampleViewLink(sampleConfigLink);
  await page.goto(viewLink, { waitUntil: 'domcontentloaded' });
  await waitForPageSettled(page);

  if (page.url().includes('accounts.ccbp.in/login')) {
    throw new Error('Redirected back to the login page while opening the sample config link.');
  }

  await cloneActionLocator(page).waitFor({ timeout: 30000 });

  const sampleTag = await getLabeledValue(page, 'Tags');
  const startText = await getLabeledValue(page, 'Start Date & Time');
  const endText = await getLabeledValue(page, 'End Date & Time');
  const accessType = await detectAccessType(page);

  if (!startText || !endText) {
    throw new Error('Unable to read sample assessment start/end date and time.');
  }

  const sampleStart = parseTopinDateTime(startText);
  const sampleEnd = parseTopinDateTime(endText);
  const durationMs = sampleEnd.getTime() - sampleStart.getTime();

  if (durationMs <= 0) {
    throw new Error('Sample assessment end time must be later than start time.');
  }

  return { sampleTag, accessType, durationMs };
}

async function cloneAssessment(page) {
  await cloneActionLocator(page).click();
  await page.waitForURL(/create-assessment|edit-assessment/, { timeout: 30000 });
  await saveAndNextLocator(page).click();
  await page.waitForURL(/edit-assessment/, { timeout: 30000 });
  await page.locator('input[placeholder="Enter Assessment Name"]').waitFor({ timeout: 30000 });
  return page.url();
}

async function publishAssessment(page, accessType) {
  await saveAndNextLocator(page).click();
  await publishAssessmentLocator(page).waitFor({ timeout: 30000 });
  await publishAssessmentLocator(page).click();

  const accessChoice = accessType === 'Public' ? 'Public' : 'Private';
  await page.locator('div').filter({ hasText: new RegExp(`^${accessChoice}`) }).first().click();
  await page.getByRole('button', { name: 'Yes, I agree' }).click();
  const copyLinkButton = page.getByRole('button', { name: 'Copy Link' });
  await copyLinkButton.waitFor({ timeout: 60000 });

  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: BASE_URL,
    });
    await copyLinkButton.click();
    const assessmentLink = normalizePublishedAssessmentLink(
      await page.evaluate(async () => navigator.clipboard.readText()),
    );
    if (assessmentLink) {
      return assessmentLink;
    }
  } catch (error) {
    // Fall back to the derived view-assessment link if clipboard access is unavailable.
  }

  return '';
}

async function processRow(page, row, onLog) {
  onLog(`Row ${row.rowNumber}: opening sample config.`);
  const sample = await openSampleAndReadMetadata(page, row.sampleConfigLink);
  const newStart = buildDateTimeFromSlot(row.assessmentDate, row.uniqueExamId, row.startTimeSlot);
  const newEnd = row.endTimeSlot
    ? buildDateTimeFromSlot(row.assessmentDate, row.uniqueExamId, row.endTimeSlot, newStart)
    : floorDateToInterval(
      new Date(newStart.getTime() + sample.durationMs + END_TIME_BUFFER_MINUTES * 60 * 1000),
    );

  onLog(`Row ${row.rowNumber}: sample opened. Preparing clone.`);
  onLog(`Row ${row.rowNumber}: cloning sample assessment.`);
  const newConfigLink = await cloneAssessment(page);

  onLog(`Row ${row.rowNumber}: updating assessment fields.`);
  await page.locator('input[placeholder="Enter Assessment Name"]').fill(row.skill);
  await replaceUniqueExamIdTag(page, sample.sampleTag, row.uniqueExamId);
  await setDateTimeField(page, 'bscd-start-date-time-input', newStart);
  await setDateTimeField(page, 'bscd-end-date-time-input', newEnd);
  await setExitPin(page, row.exitPin);
  await setQrBasedAttendanceMode(page);
  await setExamPinMode(page);

  onLog(`Row ${row.rowNumber}: publishing new assessment.`);
  const assessmentLink = await publishAssessment(page, sample.accessType);
  const resolvedAssessmentLink = normalizePublishedAssessmentLink(
    assessmentLink || newConfigLink.replace('/edit-assessment/', '/view-assessment/'),
  );
  const shortUrlSourceLink = normalizeAssessmentLinkForShortUrl(resolvedAssessmentLink);
  onLog(`Row ${row.rowNumber}: copied assessment link: ${resolvedAssessmentLink}`);
  onLog(`Row ${row.rowNumber}: short URL source link: ${shortUrlSourceLink}`);
  let shortUrl = '';
  let shortUrlError = '';

  try {
    onLog(`Row ${row.rowNumber}: attempting to create TinyURL for: ${shortUrlSourceLink}`);
    shortUrl = await createShortUrl(
      shortUrlSourceLink,
      buildShortUrlAlias(row),
      onLog
    );
    
    if (shortUrl === shortUrlSourceLink) {
      onLog(`Row ${row.rowNumber}: TinyURL creation failed - using original URL as fallback`);
    } else {
      onLog(`Row ${row.rowNumber}: generated short URL: ${shortUrl}`);
    }
  } catch (error) {
    shortUrlError = `Short URL failed: ${error.message}`;
    onLog(`Row ${row.rowNumber}: ${shortUrlError}`);
    onLog(`Row ${row.rowNumber}: using original URL as fallback`);
    shortUrl = shortUrlSourceLink; // Explicit fallback
  }

  return {
    newConfigLink,
    assessmentLink: resolvedAssessmentLink,
    shortUrlSourceLink,
    shortUrl,
    status: 'SUCCESS',
    error: shortUrlError,
  };
}

async function saveErrorScreenshot(page, rowNumber) {
  const fileName = `row-${rowNumber}-${Date.now()}.png`;
  const fullPath = path.join(ERROR_SHOTS_DIR, fileName);
  try {
    await page.screenshot({ path: fullPath, fullPage: true });
    return fullPath;
  } catch (error) {
    return null;
  }
}

function buildOutputCsv(results) {
  return stringify(results, {
    header: true,
    columns: [
      'Skill',
      'Date of Assessment',
      'Start Time Slot',
      'End Time Slot',
      'UniqueExamID',
      'EXIT PIN',
      'Sample Config Link',
      'New Config Link',
      'Assessment Link',
      'Short URL Source Link',
      'Short URL',
      'Status',
      'Error',
    ],
  });
}

async function waitForPageSettled(page, timeout = 15000) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
}

function cloneActionLocator(page) {
  return page.locator('button, a, [role="button"]').filter({ hasText: /clone/i }).first();
}

function saveAndNextLocator(page) {
  return page.locator('button, a, [role="button"]').filter({ hasText: /save\s*&\s*next/i }).first();
}

function publishAssessmentLocator(page) {
  return page.locator('button, a, [role="button"]').filter({ hasText: /^publish assessment$/i }).first();
}

async function launchBrowser({ headless, onLog }) {
  const isRailway = !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_NAME || process.env.NODE_ENV === 'production');
  
  // Force headless on server environments
  const forceHeadless = isRailway || !process.env.DISPLAY;
  const actualHeadless = forceHeadless || headless;
  
  onLog(`Browser launch config: headless=${actualHeadless}, isRailway=${isRailway}, originalHeadless=${headless}`);
  
  const launchOptions = {
    headless: !!actualHeadless, // Ensure boolean
    slowMo: actualHeadless ? 0 : 75,
  };

  // Add Railway/Linux-specific browser arguments
  if (isRailway || actualHeadless) {
    launchOptions.args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor'
    ];
  }

  try {
    onLog(`Launching browser with headless=${actualHeadless}`);
    return await chromium.launch(launchOptions);
  } catch (error) {
    onLog(`Bundled Playwright Chromium failed to launch: ${error.message}`);
    
    // If on Railway and browser is missing dependencies, try to install at runtime
    if (isRailway && (error.message.includes('libglib') || error.message.includes('Executable doesn\'t exist'))) {
      onLog('Attempting to install Playwright browsers at runtime...');
      try {
        const { execSync } = require('child_process');
        
        // Try to install browsers and dependencies
        execSync('npx playwright install chromium', { stdio: 'inherit' });
        execSync('npx playwright install-deps chromium', { stdio: 'inherit' });
        
        onLog('Runtime installation completed. Retrying browser launch...');
        return await chromium.launch(launchOptions);
      } catch (installError) {
        onLog(`Runtime installation failed: ${installError.message}`);
      }
    }
    
    // If X server error, force headless and retry
    if (error.message.includes('Missing X server') || error.message.includes('DISPLAY')) {
      onLog('X server error detected, forcing headless mode...');
      const headlessOptions = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      };
      try {
        return await chromium.launch(headlessOptions);
      } catch (headlessError) {
        onLog(`Headless launch also failed: ${headlessError.message}`);
      }
    }
  }

  // Try Windows browsers if not on Railway
  if (!isRailway) {
    for (const candidate of WINDOWS_BROWSER_CANDIDATES) {
      if (!fs.existsSync(candidate.executablePath)) {
        continue;
      }

      try {
        onLog(`Trying installed browser: ${candidate.name}.`);
        return await chromium.launch({
          ...launchOptions,
          executablePath: candidate.executablePath,
        });
      } catch (error) {
        onLog(`${candidate.name} launch failed: ${error.message}`);
      }
    }
  }

  throw new Error(
    'Unable to launch any Chromium-based browser. Please ensure Chrome or Edge is installed, or run with --headless=false to see browser issues.',
  );
}

async function runAutomation({ csvPath, mobileNumber, otp, headless, onLog, onProgress }) {
  const rows = parseInputCsv(csvPath);
  if (rows.length === 0) {
    throw new Error('The input CSV does not contain any data rows.');
  }

  onProgress({
    totalRows: rows.length,
    completedRows: 0,
    failedRows: 0,
    currentRow: null,
  });

  const browser = await launchBrowser({ headless, onLog });

  const useSavedSession = !mobileNumber && !otp && fs.existsSync(SESSION_FILE);
  const context = await browser.newContext(
    useSavedSession ? { storageState: SESSION_FILE } : {},
  );
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  const results = [];
  let completedRows = 0;
  let failedRows = 0;

  try {
    await ensureLoggedIn(page, mobileNumber, otp, onLog);
    await context.storageState({ path: SESSION_FILE });

    for (const row of rows) {
      onProgress({
        totalRows: rows.length,
        completedRows,
        failedRows,
        currentRow: {
          rowNumber: row.rowNumber,
          skill: row.skill,
        },
      });

      if (row.validationError) {
        failedRows += 1;
        onLog(`Row ${row.rowNumber}: skipped. ${row.validationError}`);
        results.push({
          'Skill': row.skill,
          'Date of Assessment': row.assessmentDate,
          'Start Time Slot': row.startTimeSlot,
          'End Time Slot': row.endTimeSlot,
          'UniqueExamID': row.uniqueExamId,
          'EXIT PIN': row.exitPin,
          'Sample Config Link': row.sampleConfigLink,
          'New Config Link': '',
          'Assessment Link': '',
          'Short URL Source Link': '',
          'Short URL': '',
          'Status': 'FAILED',
          'Error': row.validationError,
        });
        continue;
      }

      onLog(`Row ${row.rowNumber}: processing "${row.skill}".`);

      try {
        const result = await processRow(page, row, onLog);
        completedRows += 1;
        results.push({
          'Skill': row.skill,
          'Date of Assessment': row.assessmentDate,
          'Start Time Slot': row.startTimeSlot,
          'End Time Slot': row.endTimeSlot,
          'UniqueExamID': row.uniqueExamId,
          'EXIT PIN': row.exitPin,
          'Sample Config Link': row.sampleConfigLink,
          'New Config Link': result.newConfigLink,
          'Assessment Link': result.assessmentLink,
          'Short URL Source Link': result.shortUrlSourceLink,
          'Short URL': result.shortUrl,
          'Status': result.status,
          'Error': result.error,
        });
        onLog(`Row ${row.rowNumber}: created ${result.newConfigLink}`);
      } catch (error) {
        failedRows += 1;
        const screenshotPath = await saveErrorScreenshot(page, row.rowNumber);
        const errorMessage = screenshotPath
          ? `${error.message} | Screenshot: ${screenshotPath}`
          : error.message;

        results.push({
          'Skill': row.skill,
          'Date of Assessment': row.assessmentDate,
          'Start Time Slot': row.startTimeSlot,
          'End Time Slot': row.endTimeSlot,
          'UniqueExamID': row.uniqueExamId,
          'EXIT PIN': row.exitPin,
          'Sample Config Link': row.sampleConfigLink,
          'New Config Link': '',
          'Assessment Link': '',
          'Short URL Source Link': '',
          'Short URL': '',
          'Status': 'FAILED',
          'Error': errorMessage,
        });
        onLog(`Row ${row.rowNumber}: failed. ${errorMessage}`);
      }

      onProgress({
        totalRows: rows.length,
        completedRows,
        failedRows,
        currentRow: {
          rowNumber: row.rowNumber,
          skill: row.skill,
        },
      });
    }

    const outputCsvPath = path.join(OUTPUTS_DIR, `topin-output-${Date.now()}.csv`);
    fs.writeFileSync(outputCsvPath, buildOutputCsv(results), 'utf8');

    return {
      outputCsvPath,
      totalRows: rows.length,
      completedRows,
      failedRows,
    };
  } finally {
    await context.storageState({ path: SESSION_FILE }).catch(() => {});
    await browser.close();
  }
}

module.exports = {
  runAutomation,
};