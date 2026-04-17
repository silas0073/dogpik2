/**
 * Netlify Function: races
 * Greyhound Oracle - scrapes thedogs.com.au directly
 * No auth, no geo-blocking issues
 */

const BASE = "https://www.thedogs.com.au";

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-AU,en;q=0.9",
    }
  });
  return res.text();
}

function getToday() {
  const aest = new Date(Date.now() + 10 * 3600000);
  return aest.toISOString().split("T")[0];
}

function extractNextData(html) {
  // thedogs.com.au is a Rails app - no NEXT_DATA, parse HTML directly
  return null;
}

function extractMeetings(html, today) {
  const meetings = [];
  const seen = new Set();
  const parts = html.split("<a ");
  for (const part of parts) {
    const hrefMatch = part.match(/href="\/racing\/([a-z0-9-]+)\/([0-9]{4}-[0-9]{2}-[0-9]{2})/);
    if (!hrefMatch) continue;
    const venueSlug = hrefMatch[1];
    const date = hrefMatch[2];
    if (date !== today || seen.has(venueSlug)) continue;
    seen.add(venueSlug);
    const stateMatch = part.match(/\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/);
    const state = stateMatch ? stateMatch[1] : "—";
    const name = venueSlug.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    meetings.push({ venueSlug, name, state, date });
  }
  return meetings;
}

function extractRaceLinks(html, venueSlug, today) {
  const races = [];
  const seen = new Set();
  const parts = html.split("<a ");
  for (const part of parts) {
    const prefix = 'href="/racing/' + venueSlug + '/' + today + '/';
    if (!part.includes(prefix)) continue;
    const after = part.slice(part.indexOf(prefix) + prefix.length);
    const numEnd = after.indexOf('/');
    const slugEnd = after.indexOf('"', numEnd + 1);
    if (numEnd < 0 || slugEnd < 0) continue;
    const raceNum = parseInt(after.slice(0, numEnd));
    const raceSlug = after.slice(numEnd + 1, slugEnd)
      .split("?")[0]
      .replace("/odds", "")
      .replace("/preview", "")
      .replace("/expert-form", "");
    if (!seen.has(raceNum) && raceNum > 0 && raceNum <= 20 && raceSlug.length > 0) {
      seen.add(raceNum);
      races.push({ raceNum, raceSlug });
    }
  }
  return races.sort((a, b) => a.raceNum - b.raceNum);
}

// Parse runners from thedogs.com.au HTML table
// Structure: <table class="race-runners ..."><tbody><tr class="race-runner">...
function parseRunners(data, html) {
  const runners = [];
  if (!html) return runners;

  // Split into tbody blocks - each tbody is one runner
  const tbodies = html.split("<tbody>");
  
  for (const tbody of tbodies.slice(1)) { // skip first split
    // Skip scratched runners
    if (tbody.includes("race-runner--scratched")) continue;
    
    // Box number from rug sprite: name="rug_4" -> box 4
    const rugMatch = tbody.match(/name="rug_([0-9])"/);
    const boxNum = rugMatch ? parseInt(rugMatch[1]) : 0;
    if (!boxNum) continue;

    // Dog name from link
    const nameMatch = tbody.match(/class="[^"]*race-runners__name__dog[^"]*"[^>]*>[^<]*<a[^>]*>([^<]+)<\/a>/);
    const name = nameMatch ? nameMatch[1].trim() : "Unknown";

    // Best time
    const timeMatch = tbody.match(/class="race-runners__name__time">([^<]+)</);
    const bestTime = timeMatch ? timeMatch[1].trim() : "—";

    // Trainer
    const trainerMatch = tbody.match(/class="race-runners__trainer"><a[^>]*>([^<]+)<\/a>/);
    const trainer = trainerMatch ? trainerMatch[1].trim() : "—";

    // Starting price (SP) - used as odds
    const spMatch = tbody.match(/class="race-runners__starting-price">\$([0-9.]+)</);
    const sp = spMatch ? parseFloat(spMatch[1]) : 0;

    // Finish position if result
    const posMatch = tbody.match(/class="race-runners__finish-position">([^<]+)</);
    const position = posMatch ? posMatch[1].trim() : null;

    const odds = sp > 0 ? sp : 0;
    const placeOdds = odds > 0 ? Math.round((1 + (odds - 1) * 0.38) * 100) / 100 : 0;

    runners.push({
      number:    boxNum,
      name,
      trainer,
      form:      "—",  // form needs separate page
      bestTime,
      odds,
      placeOdds,
      finishPosition: position,
    });
  }
  
  // Sort by box number
  return runners.sort((a, b) => a.number - b.number);
}

function parseOddsPage(html, runners) {
  // Parse OPEN odds from the /odds page table
  const openMatches = [];
  const openPattern = /OPEN\s+([\d.]+)/g;
  let m;
  while ((m = openPattern.exec(html)) !== null) {
    openMatches.push(parseFloat(m[1]));
  }
  if (openMatches.length > 0) {
    for (let i = 0; i < runners.length && i < openMatches.length; i++) {
      const win = openMatches[i];
      if (win > 0) {
        runners[i].odds      = win;
        runners[i].placeOdds = Math.round((1 + (win - 1) * 0.38) * 100) / 100;
      }
    }
  }
  return runners;
}

function parseRaceInfo(data, html) {
  // Parse from HTML - e.g. "Grade 5 T3 350m" in race-header__info__grade
  const gradeDistMatch = html && html.match(/class="race-header__info__grade">([^<]+)</);
  let distance = 0, grade = "—";
  if (gradeDistMatch) {
    const text = gradeDistMatch[1].trim();
    const distM = text.match(/([0-9]{3,4})m/);
    if (distM) distance = parseInt(distM[1]);
    const gradeM = text.match(/^(.+?)\s+[0-9]{3,4}m/);
    if (gradeM) grade = gradeM[1].trim();
  }
  // Start time from formatted-time data-timestamp
  const tsMatch = html && html.match(/data-timestamp="([0-9]+)"/);
  const startTime = tsMatch ? new Date(parseInt(tsMatch[1]) * 1000).toISOString() : null;
  return { distance, grade, startTime };
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  const today = getToday();
  console.log("Fetching thedogs.com.au for", today);

  try {
    // 1. Get meeting list
    const cardsHtml = await fetchPage(BASE + "/racing/racecards");
    const meetings  = extractMeetings(cardsHtml, today);
    console.log(meetings.length + " meetings found");

    // 2. Process each meeting
    const fullMeetings = await Promise.all(
      meetings.slice(0, 16).map(async (meeting) => {
        try {
          const meetingHtml = await fetchPage(BASE + "/racing/" + meeting.venueSlug + "/" + today);
          const raceLinks   = extractRaceLinks(meetingHtml, meeting.venueSlug, today);
          console.log(meeting.venueSlug + ": " + raceLinks.length + " races");

          const races = await Promise.all(
            raceLinks.slice(0, 14).map(async (r) => {
              try {
                const raceUrl = BASE + "/racing/" + meeting.venueSlug + "/" + today + "/" + r.raceNum + "/" + r.raceSlug;
                const oddsUrl = raceUrl + "/odds";

                const [raceHtml, oddsHtml] = await Promise.all([
                  fetchPage(raceUrl),
                  fetchPage(oddsUrl),
                ]);

                const raceData = extractNextData(raceHtml);
                let runners    = parseRunners(raceData, raceHtml);
                const info     = parseRaceInfo(raceData, raceHtml);

                // If no runners from JSON, try fallback HTML parse
                if (runners.length === 0) {
                  console.log("Runners from HTML: " + runners.length + " for " + meeting.venueSlug + " R" + r.raceNum);
                }

                // Patch odds from /odds page
                runners = parseOddsPage(oddsHtml, runners);

                // Fix distance from page if not in JSON
                let distance = info.distance;
                if (!distance) {
                  const dm = raceHtml.match(/\b([2-8][0-9]{2})m\b/);
                  if (dm) distance = parseInt(dm[1]);
                }

                return {
                  id:          meeting.venueSlug + "-r" + r.raceNum,
                  raceNumber:  r.raceNum,
                  raceName:    "Race " + r.raceNum + (distance ? " — " + distance + "m" : ""),
                  distance,
                  grade:       info.grade,
                  startTime:   info.startTime || new Date(Date.now() + r.raceNum * 15 * 60000).toISOString(),
                  status:      "Open",
                  meeting:     meeting.name,
                  state:       meeting.state,
                  venueId:     meeting.venueSlug,
                  runners,
                  isCompleted: false,
                  liveResult:  null,
                };
              } catch(e) {
                console.warn("Race failed " + meeting.venueSlug + " R" + r.raceNum + ": " + e.message);
                return null;
              }
            })
          );

          const validRaces = races.filter(r => r !== null);
          const distances  = [...new Set(validRaces.map(r => r.distance))].filter(Boolean).sort((a, b) => a - b);

          return { id: meeting.venueSlug, name: meeting.name, state: meeting.state, distances, races: validRaces };
        } catch(e) {
          console.warn("Meeting failed " + meeting.venueSlug + ": " + e.message);
          return null;
        }
      })
    );

    const valid = fullMeetings.filter(m => m && m.races.length > 0);
    console.log(valid.length + " valid meetings");

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ meetings: valid, fetchedAt: new Date().toISOString(), date: today, source: "thedogs.com.au" }),
    };

  } catch(err) {
    console.error("Handler error:", err.message);
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
