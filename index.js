const express = require('express');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────
const PRP_API_URL = (process.env.PRP_API_URL || 'https://prp-ivnf.onrender.com').replace(/\/$/, '');
const TELE_LIBRARY_URL = (process.env.TELE_LIBRARY_URL || 'https://tele-to-gofile.onrender.com').replace(/\/$/, '');
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS) || 30000;
const PORT = process.env.PORT || 3002;
const MATCH_THRESHOLD = 0.4; // 40% of keywords must match

// ─── Activity Log ────────────────────────────────────────────────
const activityLog = [];
const MAX_LOG_SIZE = 200;

function log(type, message, details = {}) {
    const entry = {
        time: new Date().toISOString(),
        type, // 'info', 'match', 'miss', 'error', 'complete'
        message,
        ...details,
    };
    activityLog.unshift(entry);
    if (activityLog.length > MAX_LOG_SIZE) activityLog.pop();

    const icons = { info: 'ℹ️', match: '✅', miss: '❌', error: '⚠️', complete: '🎯', poll: '🔄' };
    console.log(`${icons[type] || '📝'} [${entry.time}] ${message}`);
}

// ─── Stats ───────────────────────────────────────────────────────
const stats = {
    startTime: new Date().toISOString(),
    totalPolls: 0,
    totalMatches: 0,
    totalMisses: 0,
    totalErrors: 0,
    lastPollTime: null,
    lastMatchTime: null,
    processedIds: new Set(), // Track requests we've already attempted
};

// ─── Fuzzy Matching ──────────────────────────────────────────────

/**
 * Normalize a string for comparison:
 * - lowercase
 * - remove file extensions
 * - remove special chars (keep alphanumeric and spaces)
 * - collapse whitespace
 */
function normalize(str) {
    return str
        .toLowerCase()
        .replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|rar|zip|7z|srt|sub|ass)$/gi, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Levenshtein distance — measures how many edits (insert/delete/replace)
 * are needed to turn string 'a' into string 'b'.
 * Used to handle typos like "Baashha" vs "Baasha".
 */
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

/**
 * Similarity score between two strings (0 to 1).
 * 1 = identical, 0 = completely different.
 */
function similarity(a, b) {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Check if a keyword fuzzy-matches any word in the file name.
 * Returns the best similarity score (0-1).
 */
function fuzzyKeywordMatch(keyword, fileWords) {
    let bestSim = 0;
    // Check exact inclusion first
    const fileStr = fileWords.join(' ');
    if (fileStr.includes(keyword)) return 1.0;
    // Check each word for fuzzy match
    for (const word of fileWords) {
        const sim = similarity(keyword, word);
        if (sim > bestSim) bestSim = sim;
    }
    return bestSim;
}

/**
 * Extract meaningful keywords from a movie name,
 * filtering out very short or common filler words
 */
function extractKeywords(name) {
    const stopWords = new Set([
        'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or',
        'is', 'it', 'by', 'with', 'from', 'as', 'this', 'that', 'but', 'not',
        'movie', 'film', 'full', 'hd', 'download', 'free', 'watch', 'online',
        'hindi', 'english', 'tamil', 'telugu', 'malayalam', 'dubbed',
        '480p', '720p', '1080p', '2k', '4k', 'bluray', 'webrip', 'dvdrip',
        'hdrip', 'camrip', 'hdcam', 'web', 'dl',
    ]);

    return normalize(name)
        .split(' ')
        .filter(w => w.length >= 2 && !stopWords.has(w));
}

/**
 * Score how well a file matches a movie request.
 * Uses fuzzy matching (Levenshtein distance) to handle typos.
 * Returns a score between 0 and 1.
 */
function scoreMatch(movieName, fileName) {
    const movieKeywords = extractKeywords(movieName);
    if (movieKeywords.length === 0) return 0;

    const normalizedFile = normalize(fileName);
    const fileWords = normalizedFile.split(' ').filter(w => w.length >= 2);

    let totalScore = 0;
    for (const keyword of movieKeywords) {
        const kwScore = fuzzyKeywordMatch(keyword, fileWords);
        // Only count as a match if similarity > 0.6 (allows 1-2 char typos)
        if (kwScore >= 0.6) {
            totalScore += kwScore;
        }
    }

    return totalScore / movieKeywords.length;
}

/**
 * Find the best matching file for a movie request.
 * Returns { file, score } or null if no good match.
 */
function findBestMatch(movieName, files) {
    let bestFile = null;
    let bestScore = 0;

    for (const file of files) {
        const score = scoreMatch(movieName, file.fileName);
        if (score > bestScore) {
            bestScore = score;
            bestFile = file;
        }
    }

    if (bestScore >= MATCH_THRESHOLD && bestFile) {
        return { file: bestFile, score: bestScore };
    }

    return null;
}

// ─── API Communication ───────────────────────────────────────────

/**
 * Fetch all requests from the Movie Request Portal
 */
async function fetchRequests() {
    const response = await fetch(`${PRP_API_URL}/api/requests`);
    if (!response.ok) throw new Error(`PRP API returned ${response.status}`);
    return response.json();
}

/**
 * Fetch ALL files from the Telegram Library (no search filter).
 * We do matching locally with fuzzy logic instead of relying on
 * the API's exact substring search.
 */
async function fetchAllLibraryFiles() {
    const response = await fetch(`${TELE_LIBRARY_URL}/api/files`);
    if (!response.ok) throw new Error(`Telegram Library API returned ${response.status}`);
    const data = await response.json();
    return data.files || [];
}

/**
 * Update a request on the Movie Request Portal
 */
async function completeRequest(requestId, link) {
    const response = await fetch(`${PRP_API_URL}/api/requests/${requestId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed', link }),
    });
    if (!response.ok) throw new Error(`Failed to update request: ${response.status}`);
    return response.json();
}

// ─── Main Processing Loop ────────────────────────────────────────

async function processRequests() {
    stats.totalPolls++;
    stats.lastPollTime = new Date().toISOString();

    try {
        // 1. Fetch all requests
        const allRequests = await fetchRequests();
        const pendingRequests = allRequests.filter(r =>
            r.status === 'requested' && !stats.processedIds.has(r.id)
        );

        // Also count requests we completed previously
        const completedByUs = allRequests.filter(r => stats.processedIds.has(r.id)).length;

        if (pendingRequests.length === 0) {
            // Silent poll — don't log every empty poll
            return;
        }

        log('poll', `Found ${pendingRequests.length} new pending request(s)`);

        // 2. Process each pending request
        for (const request of pendingRequests) {
            const movieName = request.name;
            const movieYear = request.year || '';

            try {
                // Fetch ALL files from library and do local fuzzy matching
                log('info', `Searching for: "${movieName}" (${movieYear})`);
                const files = await fetchAllLibraryFiles();

                if (files.length === 0) {
                    log('miss', `Telegram library is empty or unavailable — will re-check next poll`, {
                        requestId: request.id,
                        movieName,
                    });
                    stats.totalMisses++;
                    continue;
                }

                // 3. Find best match
                const match = findBestMatch(movieName, files);

                if (match) {
                    // 4. Auto-complete the request
                    log('match', `Matched "${movieName}" → "${match.file.fileName}" (score: ${(match.score * 100).toFixed(0)}%)`, {
                        requestId: request.id,
                        movieName,
                        matchedFile: match.file.fileName,
                        score: match.score,
                        link: match.file.link,
                    });

                    await completeRequest(request.id, match.file.link);

                    log('complete', `Auto-completed request for "${movieName}" with link: ${match.file.link}`, {
                        requestId: request.id,
                    });

                    stats.totalMatches++;
                    stats.lastMatchTime = new Date().toISOString();
                    // Only cache completed requests — so they're not re-processed
                    stats.processedIds.add(request.id);
                } else {
                    log('miss', `No confident match for "${movieName}" (best score below ${MATCH_THRESHOLD * 100}% threshold) — will retry`, {
                        requestId: request.id,
                        movieName,
                        filesChecked: files.length,
                    });
                    stats.totalMisses++;
                    // Don't cache misses — re-check on next poll
                }

            } catch (err) {
                log('error', `Error processing "${movieName}": ${err.message}`, {
                    requestId: request.id,
                });
                stats.totalErrors++;
            }
        }

    } catch (err) {
        log('error', `Poll failed: ${err.message}`);
        stats.totalErrors++;
    }
}

// ─── Re-check previously missed requests periodically ────────────
// Every 5 minutes, clear processedIds so we re-check missed ones
// (in case new files were added to the Telegram library)
// No need to clear processedIds — only completed requests are cached,
// and misses are always re-checked automatically.

// ─── Express Server (Dashboard & API) ────────────────────────────

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        uptime: Math.floor((Date.now() - new Date(stats.startTime).getTime()) / 1000),
        config: {
            prpUrl: PRP_API_URL,
            teleLibraryUrl: TELE_LIBRARY_URL,
            pollIntervalMs: POLL_INTERVAL_MS,
            matchThreshold: MATCH_THRESHOLD,
        },
        stats: {
            startTime: stats.startTime,
            totalPolls: stats.totalPolls,
            totalMatches: stats.totalMatches,
            totalMisses: stats.totalMisses,
            totalErrors: stats.totalErrors,
            lastPollTime: stats.lastPollTime,
            lastMatchTime: stats.lastMatchTime,
        },
    });
});

// Activity logs
app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const type = req.query.type || '';
    let logs = activityLog;
    if (type) {
        logs = logs.filter(l => l.type === type);
    }
    res.json(logs.slice(0, limit));
});

// Manual trigger
app.get('/api/trigger', async (req, res) => {
    stats.processedIds.clear();
    await processRequests();
    res.json({ message: 'Processing triggered', stats });
});

// Dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ───────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`\n🤖 AI Mediator running at http://localhost:${PORT}`);
    console.log(`   📡 Movie Request Portal: ${PRP_API_URL}`);
    console.log(`   📚 Telegram Library:     ${TELE_LIBRARY_URL}`);
    console.log(`   ⏱️  Polling interval:     ${POLL_INTERVAL_MS / 1000}s`);
    console.log(`   🎯 Match threshold:      ${MATCH_THRESHOLD * 100}%\n`);

    // Start polling
    log('info', 'AI Mediator started — beginning to poll for requests');
    processRequests(); // First poll immediately
    setInterval(processRequests, POLL_INTERVAL_MS);

    // Self-ping to keep Render free tier awake
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
    if (RENDER_URL) {
        console.log(`   📡 Self-ping active for: ${RENDER_URL}`);
        setInterval(() => {
            fetch(`${RENDER_URL}/api/status`)
                .then(() => log('info', 'Self-ping successful'))
                .catch(err => log('error', `Self-ping failed: ${err.message}`));
        }, 840000); // 14 minutes
    }

    // Also ping the other two services to keep them awake
    setInterval(() => {
        fetch(`${PRP_API_URL}/api/health`).catch(() => { });
        fetch(`${TELE_LIBRARY_URL}/api/status`).catch(() => { });
    }, 840000);
});
