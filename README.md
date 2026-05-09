# Topin Clone Automation

Local web app for bulk cloning Topin assessments from a CSV file.

## What It Does

- Reads a CSV file with these columns:
  - `Skill`
  - `Date of Assessment`
  - `Start Time Slot` (optional if `UniqueExamID` ends with `_HHMM`)
  - `End Time Slot` (optional; if blank, the app falls back to sample duration plus buffer)
  - `UniqueExamID`
  - `EXIT PIN`
  - `Sample Config Link`
- Logs into `config.topin.tech`
- Opens each sample config row by row
- Clones the sample assessment
- Replaces:
  - assessment name with `Skill`
  - assessment date with the CSV `Date of Assessment`
  - start time with the CSV `Start Time Slot`, or from the `UniqueExamID` suffix like `_1000` or `_1530`
  - end time with the CSV `End Time Slot` when provided
  - CSV time slots accept values like `4:30`, `4:30 PM`, `4:30:00 PM`, or `16:30`
  - start time is rounded down to Topin's nearest available 5-minute slot when needed
  - `Date of Assessment` accepts `DD-MM-YYYY`, `DD/MM/YYYY`, or `YYYY-MM-DD`
  - if `Date of Assessment` is omitted in an older CSV, the app falls back to the date inside `UniqueExamID`
  - tag / exam id with `UniqueExamID`
  - secure browser exit pin with `EXIT PIN`
  - if `End Time Slot` is blank, end time falls back to the cloned duration plus an extra 30-minute buffer
- Publishes the assessment
- Writes a new output CSV containing the new config link, assessment link, and shortened assessment URL for each row

## Run

```bash
npm install
npx playwright install chromium
npm start
```

## Environment Variables

Create a `.env` file in the project root before starting the app:

```bash
TINYURL_API_TOKEN=your_tinyurl_api_token_here
```

Open:

```text
http://localhost:3000
```

## Notes

- The app stores a reusable Topin session in `sessions/topin-auth.json`.
- `UniqueExamID` values like `NG26_..._2026-04-01_1000` mean `2026-04-01 10:00 AM`, and `_1530` means `3:30 PM`.
- Short URLs are created through TinyURL with aliases that start from the skill code, such as `gen`, `ct`, `ctc`, `cs`, `qr`, or `ui`.
- If the saved session is valid, you can leave OTP empty.
- If the session expires, enter a fresh OTP in the app and start again.
- Output CSV files are written to `outputs/`.
- Error screenshots are written to `outputs/error-shots/`.
