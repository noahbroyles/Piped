// Remembers where each video was left off, in localStorage, so leaving or reloading the page doesn't
// lose your place. Unlike the watch history (IndexedDB), this works with that preference turned off.
// Off unless the "resumePlayback" preference is on, since it is a record of what was watched.

const STORAGE_KEY = "resumePositions";

// Only the most recently watched videos are kept, so this can't grow forever
const MAX_VIDEOS = 100;

function loadPositions() {
    try {
        const positions = JSON.parse(localStorage.getItem(STORAGE_KEY));
        return positions && typeof positions === "object" && !Array.isArray(positions) ? positions : {};
    } catch {
        // Missing, corrupted, or localStorage is blocked
        return {};
    }
}

function storePositions(positions) {
    try {
        // Leave no trace once every position is forgotten
        if (Object.keys(positions).length === 0) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
    } catch {
        // Storage full or blocked; resuming just won't work then
    }
}

/** Returns the saved position of `videoId` in seconds, or null. */
export function getResumePosition(videoId) {
    const time = loadPositions()[videoId]?.time;
    return Number.isFinite(time) && time > 0 ? time : null;
}

export function saveResumePosition(videoId, time) {
    const positions = loadPositions();
    positions[videoId] = { time: Math.floor(time), savedAt: Date.now() };

    // Forget the oldest videos beyond the limit
    const ids = Object.keys(positions);
    if (ids.length > MAX_VIDEOS) {
        ids.sort((a, b) => (positions[a].savedAt || 0) - (positions[b].savedAt || 0))
            .slice(0, ids.length - MAX_VIDEOS)
            .forEach(id => delete positions[id]);
    }

    storePositions(positions);
}

export function clearResumePosition(videoId) {
    const positions = loadPositions();
    if (!(videoId in positions)) return;
    delete positions[videoId];
    storePositions(positions);
}

/** Forgets every saved position, e.g. when the preference is turned off. */
export function clearAllResumePositions() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // localStorage is blocked, so nothing was saved either
    }
}
