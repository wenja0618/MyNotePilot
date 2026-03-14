// ===== Configuration =====

// External AI endpoint that will:
// - Read the uploaded PDF (base64)
// - Return a summary + proposed events/tasks
//
// Expected response JSON shape:
// {
//   "summary": "Short summary of the document...",
//   "events": [
//     {
//       "title": "Meeting with client",
//       "description": "Discuss contract terms",
//       "location": "Zoom",
//       "start": "2026-03-20T10:00:00-04:00",
//       "end": "2026-03-20T11:00:00-04:00"
//     }
//   ],
//   "tasks": [
//     {
//       "title": "Send follow-up email",
//       "description": "Include proposal and timeline",
//       "due": "2026-03-21"
//     }
//   ]
// }
// API key is read from Script Properties (set in Apps Script: Project settings > Script properties).
// Add property: GEMINI_API_KEY = your key from https://aistudio.google.com/app/apikey
function getGeminiApiKey_() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || '';
}

function getGeminiApiUrl_() {
  var key = getGeminiApiKey_();
  return 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=' + (key || '');
}

// Default calendar to use for events/tasks.
var DEFAULT_CALENDAR_ID = CalendarApp.getDefaultCalendar().getId();

// Web app GET entrypoint – serves the HTML UI.
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('MyNotePilot – AI notes, summaries & calendar');
}

// ===== Public API (for extension) =====

/**
 * HTTP entrypoint for the Chrome extension.
 *
 * - mode = "analyze":
 *    Input:  { mode: "analyze", fileName, mimeType, contentBase64 }
 *    Output: { summary, events, tasks }
 *
 * - mode = "create":
 *    Input:  { mode: "create", events: [...], tasks: [...] }
 *    Output: { createdEvents: n, createdTasks: m }
 *
 * No calendar changes happen in "analyze" mode.
 * Calendar entries are only created in "create" mode, after user approval.
 */
function doPost(e) {
  try {
    var body = e && e.postData && e.postData.contents
      ? JSON.parse(e.postData.contents)
      : {};

    var mode = body.mode;
    if (!mode) {
      throw new Error('Missing "mode" in request body.');
    }

    if (mode === 'analyze') {
      var analysis = analyzeDocument_(body);
      return jsonResponse_(analysis);
    }

    if (mode === 'create') {
      var result = createFromApproval_(body.events || [], body.tasks || []);
      return jsonResponse_(result);
    }

    throw new Error('Unsupported mode: ' + mode);
  } catch (err) {
    return jsonResponse_({
      error: true,
      message: err && err.message ? err.message : String(err)
    }, 400);
  }
}

// ===== Web UI helpers (used by Index.html via google.script.run) =====

/**
 * Analyze uploaded files from the HTML frontend.
 * Expects: { files: [{ fileName, mimeType, contentBase64 }, ...] }
 * Returns: { summary, events, tasks, overlaps }
 * where overlaps describes conflicts between proposed events and existing
 * calendar events in the user's default calendar.
 */
function analyzeFilesFromClient(payload) {
  payload = payload || {};
  var files = payload.files || [];
  var summaryDetail = payload.summaryDetail || 'short';

  if (!files.length) {
    throw new Error('Please upload at least one file.');
  }

  // For now, analyze just the first file with your existing analyzeDocument_
  var f = files[0];
  var analysis = analyzeDocument_({
    fileName: f.fileName,
    mimeType: f.mimeType,
    contentBase64: f.contentBase64,
    summaryDetail: summaryDetail
  });

  // Compute overlaps between suggested events and existing calendar events.
  var overlaps = findOverlappingCalendarEvents_(analysis.events || []);

  return {
    summary: analysis.summary || '',
    events: analysis.events || [],
    tasks: analysis.tasks || [],
    overlaps: overlaps
  };
}

/**
 * Create calendar entries from the HTML frontend.
 * Expects: { events: [...], tasks: [...] }
 */
function createCalendarFromClient(payload) {
  payload = payload || {};
  return createFromApproval_(payload.events || [], payload.tasks || []);
}

/**
 * Finds existing calendar events that overlap with the proposed events.
 *
 * @param {Array<Object>} proposedEvents - Events from the document (must have start/end).
 * @return {Array<Object>} overlaps - Each item: {
 *   newEventIndex: number,
 *   newEventTitle: string,
 *   newEventStart: string,
 *   newEventEnd: string,
 *   existing: [{ title, start, end, description, location }]
 * }
 */
function findOverlappingCalendarEvents_(proposedEvents) {
  var calendar = CalendarApp.getCalendarById(DEFAULT_CALENDAR_ID);
  var overlaps = [];

  (proposedEvents || []).forEach(function (e, idx) {
    if (!e || !e.start || !e.end) {
      return;
    }

    var start = new Date(e.start);
    var end = new Date(e.end);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return;
    }

    // Get any existing calendar events in this time window.
    var existingEvents = calendar.getEvents(start, end);
    if (!existingEvents || !existingEvents.length) {
      return;
    }

    var existingSummaries = existingEvents.map(function (ev) {
      return {
        title: ev.getTitle(),
        start: ev.getStartTime().toISOString(),
        end: ev.getEndTime().toISOString(),
        description: ev.getDescription(),
        location: ev.getLocation()
      };
    });

    overlaps.push({
      newEventIndex: idx,
      newEventTitle: e.title || 'Untitled event',
      newEventStart: e.start,
      newEventEnd: e.end,
      existing: existingSummaries
    });
  });

  return overlaps;
}

// Convenience function for manual testing from the Apps Script editor.
// (Does not create calendar entries.)
/**
 * Better manual test function.
 * Fetches a real public PDF to simulate a document upload.
 */
function myFunction() {
  // A public PDF sample provided by Google for testing Gemini
  var testPdfUrl = "https://storage.googleapis.com/cloud-samples-data/generative-ai/pdf/2403.05530.pdf";
  
  try {
    Logger.log("Fetching test PDF from: " + testPdfUrl);
    
    // 1. Fetch the file content
    var response = UrlFetchApp.fetch(testPdfUrl);
    var blob = response.getBlob();
    var base64Data = Utilities.base64Encode(blob.getBytes());
    
    // 2. Prepare the fake payload
    var fakeRequest = {
      mode: 'analyze',
      fileName: 'test_document.pdf',
      mimeType: 'application/pdf',
      contentBase64: base64Data
    };
    
    Logger.log("Sending analysis request to Gemini...");
    
    // 3. Call your core logic
    var result = analyzeDocument_(fakeRequest);
    
    // 4. Inspect the result
    Logger.log("--- ANALYSIS SUCCESSFUL ---");
    Logger.log("Summary: " + result.summary);
    Logger.log("Events found: " + (result.events ? result.events.length : 0));
    Logger.log("Tasks found: " + (result.tasks ? result.tasks.length : 0));
    Logger.log("Full Result: " + JSON.stringify(result, null, 2));

  } catch (err) {
    Logger.log("--- ERROR IN TEST ---");
    Logger.log(err.message);
  }
}

// ===== Core logic =====

/**
 * Uses the external AI endpoint to analyze a document.
 *
 * @param {Object} payload
 * @param {string} payload.fileName
 * @param {string} payload.mimeType
 * @param {string} payload.contentBase64
 * @param {string} [payload.summaryDetail] - 'very_concise' | 'short' | 'full'
 * @return {{summary:string, events:Array, tasks:Array}}
 */
function analyzeDocument_(payload) {
  if (!getGeminiApiKey_()) {
    throw new Error('GEMINI_API_KEY is not set. In the Apps Script editor go to Project settings > Script properties and add GEMINI_API_KEY with your API key from https://aistudio.google.com/app/apikey');
  }
  var detail = (payload && payload.summaryDetail) || 'short';
  var detailInstruction;
  if (detail === 'very_concise') {
    detailInstruction = "Make the summary extremely concise (1–2 sentences maximum), focusing only on the highest-level purpose and key deadlines.\n";
  } else if (detail === 'full') {
    detailInstruction = "Make the summary detailed and structured, 3–6 paragraphs if needed, covering sections, key topics, and all important deadlines.\n";
  } else {
    detailInstruction = "Make the summary short but informative (2–4 sentences), capturing main topics and most important deadlines.\n";
  }

  var prompt =
    "You are an assistant that extracts schedules from documents and always returns pure JSON.\n\n" +
    "Given the document content, do ALL of the following:\n" +
    "1) Write a human-readable summary of the document with this level of detail:\n" +
    detailInstruction +
    "2) Detect any explicit or implicit dates, times, and deadlines for deliverables such as tests, exams, assignments, homework, projects, meetings, interviews, appointments, or other events.\n" +
    "3) For each such item, create either an 'event' (if it has a specific time window) or a 'task' (if it is more like a due date or reminder).\n" +
    "4) If the document contains at least one date or time (like 'March 15, 2026 at 12:00 pm EST'), you MUST include at least one item in either the 'events' or 'tasks' array.\n\n" +
    "Return a single JSON object with this exact shape:\n" +
    "{\n" +
    '  \"summary\": string,\n' +
    '  \"events\": [\n' +
    "    {\n" +
    '      \"title\": string,\n' +
    '      \"description\": string,\n' +
    '      \"location\": string,\n' +
    '      \"start\": string,\n' +
    '      \"end\": string\n' +
    "    }\n" +
    "  ],\n" +
    '  \"tasks\": [\n' +
    "    {\n" +
    '      \"title\": string,\n' +
    '      \"description\": string,\n' +
    '      \"due\": string\n' +
    "    }\n" +
    "  ]\n" +
    "}\n\n" +
    "Rules:\n" +
    "- Use ISO 8601 for event start/end, including timezone when specified in the text. If the text mentions EST, use America/New_York.\n" +
    "- Use YYYY-MM-DD for task 'due' dates.\n" +
    "- Derive 'title' from the nearby sentence, e.g. 'Test', 'Meeting with X', 'Homework 1 due'.\n" +
    "- If there are no clear dates or deadlines at all, return an empty 'events' and 'tasks' array.\n" +
    "- Output ONLY valid JSON with no backticks, code fences, or explanations.";
  var geminiBody = {
    "contents": [{
      "parts": [{ "text": prompt }, { "inline_data": { "mime_type": payload.mimeType, "data": payload.contentBase64 }}]
    }],
    "generationConfig": { "response_mime_type": "application/json" }
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(geminiBody),
    muteHttpExceptions: true
  };

  // --- START RETRY LOGIC ---
  var maxRetries = 3;
  var sleepTime = 2000; // Start with 2 seconds

  for (var i = 0; i < maxRetries; i++) {
    var response = UrlFetchApp.fetch(getGeminiApiUrl_(), options);
    var code = response.getResponseCode();
    var text = response.getContentText();

    if (code === 200) {
      var result = JSON.parse(text);
      return JSON.parse(result.candidates[0].content.parts[0].text);
    } 
    
    if (code === 429) {
      Logger.log("Rate limited. Retrying in " + sleepTime + "ms... (Attempt " + (i + 1) + ")");
      Utilities.sleep(sleepTime);
      sleepTime *= 2; // Double the wait time for next try
      continue;
    }

    throw new Error("Gemini Error: " + text);
  }
  throw new Error("Exceeded max retries due to rate limiting.");
}

/**
 * Creates calendar events/tasks from user-approved items.
 *
 * Behaviour:
 * - Events: created as normal timed events.
 * - Tasks:
 *   - If t.autoPlan && t.due && t.estimatedHours: create multiple
 *     study/work blocks before the due date.
 *   - Otherwise: create a single all-day "[Task]" calendar entry on the due date.
 *
 * @param {Array<Object>} events
 * @param {Array<Object>} tasks
 * @return {{createdEvents:number, createdTasks:number, plannedBlocks:number}}
 */
function createFromApproval_(events, tasks) {
  var calendar = CalendarApp.getCalendarById(DEFAULT_CALENDAR_ID);
  var createdEvents = 0;
  var createdTasks = 0;
  var plannedBlocks = 0;

  // Create normal timed events
  (events || []).forEach(function (e) {
    if (!e || !e.start || !e.end) {
      return;
    }
    var start = new Date(e.start);
    var end = new Date(e.end);

    calendar.createEvent(e.title || 'Untitled Event', start, end, {
      description: e.description || '',
      location: e.location || ''
    });
    createdEvents++;
  });

  // Create tasks: either as auto-planned study blocks or single all-day entries
  (tasks || []).forEach(function (t) {
    if (!t || !t.due) {
      return;
    }

    var shouldAutoPlan = t.autoPlan && t.estimatedHours;
    if (shouldAutoPlan) {
      // 1) Create the core task as an all-day entry on the due date
      var autoDueDate = new Date(t.due + 'T00:00:00');
      calendar.createAllDayEvent(
        '[Task] ' + (t.title || 'Untitled Task'),
        autoDueDate,
        {
          description: (t.description || '') + '\n\n(Auto-planned study/work blocks will appear before this due date.)'
        }
      );
      createdTasks++;

      // 2) Then schedule multiple study/work blocks before the due date
      plannedBlocks += scheduleTimeBlocksForTask_(calendar, t);
      return;
    }

    // Fallback: create a single all-day task entry on the due date.
    var dueDate = new Date(t.due + 'T00:00:00');

    calendar.createAllDayEvent(
      '[Task] ' + (t.title || 'Untitled Task'),
      dueDate,
      {
        description: t.description || ''
      }
    );
    createdTasks++;
  });

  return {
    createdEvents: createdEvents,
    createdTasks: createdTasks,
    plannedBlocks: plannedBlocks
  };
}

/**
 * Schedules multiple time blocks in the calendar for a single task.
 *
 * Expected task fields:
 * - title: string
 * - description: string
 * - due: "YYYY-MM-DD"
 * - estimatedHours: number (total hours of work)
 * - blockLengthMinutes: number (length of each block, default 60)
 * - startWindowDaysBeforeDue: number (how many days before due to start scheduling, default 7)
 * - maxDailyHours: optional number of hours per day (default 3)
 *
 * Strategy (simple version):
 * - Work day by day from the start of the planning window up to the day before the due date.
 * - Place blocks in an evening window (e.g. 7–10pm) or until maxDailyHours is reached.
 * - Avoid overlapping with existing calendar events or other study blocks created in this loop.
 *
 * @param {Calendar} calendar
 * @param {Object} task
 * @return {number} number of blocks created
 */
function scheduleTimeBlocksForTask_(calendar, task) {
  var estimatedHours = Number(task.estimatedHours) || 0;
  if (!estimatedHours || !task.due) {
    return 0;
  }

  var blockMinutes = Number(task.blockLengthMinutes) || 60;
  var startWindowDays = Number(task.startWindowDaysBeforeDue) || 7;
  var maxDailyHours = task.maxDailyHours != null ? Number(task.maxDailyHours) : 3;
  if (maxDailyHours <= 0) {
    maxDailyHours = 3;
  }

  var totalMinutes = Math.round(estimatedHours * 60);
  var blocksNeeded = Math.ceil(totalMinutes / blockMinutes);
  if (blocksNeeded <= 0) {
    return 0;
  }

  var msPerDay = 24 * 60 * 60 * 1000;
  var dueDate = new Date(task.due + 'T00:00:00');

  // Planning window: from (due - startWindowDays) up to the day before due.
  var startDate = new Date(dueDate.getTime() - startWindowDays * msPerDay);

  var blocksCreated = 0;

  for (var d = new Date(startDate.getTime()); d < dueDate && blocksCreated < blocksNeeded; d = new Date(d.getTime() + msPerDay)) {
    var dailyMinutesAvailable = maxDailyHours * 60;
    var dailyBlocksMax = Math.floor(dailyMinutesAvailable / blockMinutes);
    if (dailyBlocksMax <= 0) {
      continue;
    }

    // Collect existing events on this day to avoid overlaps.
    var existingEvents = calendar.getEventsForDay(d);
    var busyIntervals = [];
    existingEvents.forEach(function (ev) {
      busyIntervals.push({
        start: ev.getStartTime().getTime(),
        end: ev.getEndTime().getTime()
      });
    });

    // Also keep track of study blocks we add on this day to avoid
    // overlapping with ourselves.
    var plannedIntervals = [];

    // Start of the evening window: 19:00 (7pm) local time.
    var windowStart = new Date(d.getTime());
    windowStart.setHours(19, 0, 0, 0);

    // End of the evening window: 22:00 (10pm) local time.
    var windowEnd = new Date(d.getTime());
    windowEnd.setHours(22, 0, 0, 0);

    // Try to place up to dailyBlocksMax blocks within this window.
    var blockStart = new Date(windowStart.getTime());

    var blocksPlacedToday = 0;
    while (blocksPlacedToday < dailyBlocksMax && blocksCreated < blocksNeeded) {
      var blockEnd = new Date(blockStart.getTime() + blockMinutes * 60 * 1000);

      // If we run past the window end, stop for the day.
      if (blockEnd.getTime() > windowEnd.getTime()) {
        break;
      }

      var blockStartMs = blockStart.getTime();
      var blockEndMs = blockEnd.getTime();

      // Check for overlap with existing events or already-planned blocks.
      var overlaps = busyIntervals.some(function (iv) {
        return blockStartMs < iv.end && blockEndMs > iv.start;
      }) || plannedIntervals.some(function (iv) {
        return blockStartMs < iv.end && blockEndMs > iv.start;
      });

      if (!overlaps) {
        calendar.createEvent(
          'Study: ' + (task.title || 'Untitled Task'),
          blockStart,
          blockEnd,
          {
            description: (task.description || '') + '\n\n(Auto-planned study block before due date.)'
          }
        );

        plannedIntervals.push({ start: blockStartMs, end: blockEndMs });
        blocksCreated++;
        blocksPlacedToday++;
      }

      // Move to the next candidate slot, directly after this block.
      blockStart = new Date(blockEnd.getTime());
    }
  }

  return blocksCreated;
}

// ===== Helpers =====

function jsonResponse_(obj, statusCode) {
  var output = ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);

  // Apps Script cannot actually set arbitrary HTTP status codes
  // on web apps, but we keep this param for future flexibility.
  if (statusCode) {
    // no-op in standard web apps, but you could log or branch on it.
  }

  return output;
}

