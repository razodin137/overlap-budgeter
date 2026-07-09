"use strict";

    const STORAGE_KEY = "overlapBudgeter.v1";
    const DEFAULT_WAKE = "08:00";   // 8:00am
    const DEFAULT_BED = "22:30";     // 10:30pm

    /* ── Wall-clock helpers. The day is framed by a sleep/wake cycle:
       wake → bed defines the bank of time (e.g. 8:00am→10:30pm = 14.5h).
       Times are "HH:MM" strings; we work in minutes-since-midnight. ── */
    function timeToMin(t) {
        if (typeof t !== 'string' || !t.includes(':')) return 0;
        const [h, m] = t.split(':').map(n => parseInt(n, 10) || 0);
        return Math.max(0, Math.min(1439, h * 60 + m));
    }
    function dayBoundsMin() {
        let wake = timeToMin(state.wake);
        let bed = timeToMin(state.bed);
        if (bed <= wake) bed += 1440;   // bed past midnight → wrap
        return { wake, bed, len: bed - wake };
    }
    function dayLengthHours() { return dayBoundsMin().len / 60; }
    // The bank IS the wake→bed window now (replaces the old manual total-bank input).
    function bankHours() { return dayLengthHours(); }
    function nowMin() {
        const d = new Date(nowMs());
        const n = d.getHours() * 60 + d.getMinutes();
        const { wake, bed, len } = dayBoundsMin();   // bed already +1440 if wrapped
        // Position the current wall-clock on the day's linear wake→bed axis.
        let pos = n - wake;
        if (pos < 0) pos += 1440;       // past midnight into a wrapped day
        if (pos <= 0) return wake;
        if (pos >= len) return bed;
        return wake + pos;
    }
    function nowPctOfDay() {
        const { wake, len } = dayBoundsMin();
        return len > 0 ? Math.max(0, Math.min(100, (nowMin() - wake) / len * 100)) : 0;
    }

    /* ── One fixed color set. Each row gets its own color by index, in creation order. ── */
    const PALETTE = ['#ef476f', '#11f1f7', '#bc8efc', '#fb8500', '#8338ec', '#f72585', '#3a0ca3'];
    let colorIdx = 0;
    function pickColor() { return PALETTE[colorIdx++ % PALETTE.length]; }

    function uid() { return Math.random().toString(36).slice(2, 10); }
    function nowMs() { return Date.now(); }

    // --- State ---
    // Each block: { id, name, hours|percent, banked(seconds), startedAt(ms|null), color, alarmed }
    let state = {
        wake: DEFAULT_WAKE,
        bed: DEFAULT_BED,
        multitask: false,
        mode: 'run',      // the app now lives in the run view; editing is per-category via hold-to-edit
        nowMode: false,    // "Start from NOW" reflow active?
        fixed: [],
        percent: [],
    };

    let undoState = null;
    let undoTimer = null;
    let toastTimer = null;
    let liveAllocs = null;   // most recent computeNowAllocations() result, shared with updateRow/timeline

    // Stable element refs so we never rebuild inputs mid-typing.
    const rowEls = {};   // id -> { row, timer, timerElapsed, timerBudget, btn, progress, progressFill }
    const segEls = {};   // id -> segment div
    const blobEls = {};  // `${id}:${idx}` -> spent-blob div
    let freeSeg = null;

    // --- Persistence ---
    function save() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    }
    function load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return false;
            const s = JSON.parse(raw);
            if (s && typeof s === 'object') {
                state = {
                    wake: typeof s.wake === 'string' ? s.wake : DEFAULT_WAKE,
                    bed: typeof s.bed === 'string' ? s.bed : DEFAULT_BED,
                    multitask: !!s.multitask,
                    mode: 'run',
                    nowMode: !!s.nowMode,
                    fixed: Array.isArray(s.fixed) ? s.fixed.map(norm) : [],
                    percent: Array.isArray(s.percent) ? s.percent.map(norm) : [],
                };
                // Old saves (pre-NOW) had a numeric totalBank and no wake/bed — migrated to defaults above.
                return true;
            }
        } catch (e) {}
        return false;
    }
    function norm(b) {
        return {
            id: b.id || uid(),
            name: b.name || 'Task',
            hours: b.hours || 0,
            percent: b.percent || 0,
            time: b.time || '',   // fixed blocks only: optional HH:MM start time-of-day
            done: !!b.done,       // marked finished → fixed releases leftover to percent splits; percent settles at usedSec
            usedSec: b.usedSec || 0,   // percent only: time declared used when marked done (drives the reflow)
            banked: b.banked || 0,
            startedAt: b.startedAt || null,
            color: b.color || pickColor(),
            alarmed: !!b.alarmed,
            intervals: Array.isArray(b.intervals) ? b.intervals.map(iv => ({ s: iv.s || 0, e: iv.e || 0 })) : [],
        };
    }

    function seedDefaults() {
        state.fixed = [
            { id: uid(), name: 'Breakfast', hours: 0.5, time: '', banked: 0, startedAt: null, color: pickColor(), alarmed: false, intervals: [], done: false },
            { id: uid(), name: 'Lunch', hours: 0.5, time: '', banked: 0, startedAt: null, color: pickColor(), alarmed: false, intervals: [], done: false },
            { id: uid(), name: 'Transitions', hours: 1, time: '', banked: 0, startedAt: null, color: pickColor(), alarmed: false, intervals: [], done: false },
            { id: uid(), name: 'Night wind-down', hours: 1, time: '', banked: 0, startedAt: null, color: pickColor(), alarmed: false, intervals: [], done: false },
        ];
        state.percent = [
            { id: uid(), name: 'Tithe', percent: 10, banked: 0, startedAt: null, color: pickColor(), alarmed: false, intervals: [] },
            { id: uid(), name: 'Freedom Fund', percent: 10, banked: 0, startedAt: null, color: pickColor(), alarmed: false, intervals: [] },
            { id: uid(), name: 'Bills', percent: 50, banked: 0, startedAt: null, color: pickColor(), alarmed: false, intervals: [] },
            { id: uid(), name: 'Education', percent: 10, banked: 0, startedAt: null, color: pickColor(), alarmed: false, intervals: [] },
            { id: uid(), name: 'Desires', percent: 10, banked: 0, startedAt: null, color: pickColor(), alarmed: false, intervals: [] },
            { id: uid(), name: 'Fun', percent: 10, banked: 0, startedAt: null, color: pickColor(), alarmed: false, intervals: [] },
        ];
    }

    // --- Timing (timestamp-based: survives reload, background throttling, sleep) ---
    function elapsedOf(b) {
        return b.banked + (b.startedAt ? Math.floor((nowMs() - b.startedAt) / 1000) : 0);
    }
    // Time actually charged against a block's budget: the running elapsed total, except
    // for done percent categories, which settle on the amount the user declared.
    function spentSec(b) {
        return (state.percent.some(x => x.id === b.id) && b.done) ? (b.usedSec || 0) : elapsedOf(b);
    }
    function startBlock(b) {
        if (b.startedAt) return;
        if (!state.multitask) {
            [...state.fixed, ...state.percent].forEach(o => {
                if (o !== b && o.startedAt) stopBlock(o);
            });
        }
        b.startedAt = nowMs();
        b.alarmed = false;       // re-arm the alarm when a fresh run begins
        b.done = false;          // resuming a finished block un-finishes it (re-reserves its plan)
        // Solo starts auto-open the zen overlay; overlapping starts do not.
        if (!state.multitask) { zenOpen = true; updateZenVisibility(); }
    }
    // DONE: stop the timer (banking what was spent) and release any leftover planned
    // time back to the percent splits. Toggling again undoes it (re-reserves the plan).
    function toggleDone(b) {
        if (b.done) { b.done = false; }
        else { if (b.startedAt) stopBlock(b); b.done = true; b.alarmed = false; }
        save(); updateLive();
    }
    function stopBlock(b) {
        if (!b.startedAt) return;
        const end = nowMs();
        b.banked += Math.floor((end - b.startedAt) / 1000);
        // Log the wall-clock interval so the NOW timeline can draw a spent blob for it.
        if (!Array.isArray(b.intervals)) b.intervals = [];
        b.intervals.push({ s: b.startedAt, e: end });
        b.startedAt = null;
        b.alarmed = false;
    }
    function toggleBlock(listKey, id) {
        const b = state[listKey].find(x => x.id === id);
        if (!b) return;
        if (b.startedAt) stopBlock(b); else startBlock(b);
        save();
        updateLive();
    }

    // --- Budget helpers ---
    // A fixed block "reserves" time out of the day's bank. While not done it reserves
    // its full planned budget; once DONE it reserves only what was actually spent, so
    // any leftover flows back into the percent splits (their budgets grow). This is the
    // single knob both the timeline layout and the percent split read from.
    function plannedSec(b) { return (b.hours || 0) * 3600; }
    function reserveSec(b) { return b.done ? Math.min(plannedSec(b), elapsedOf(b)) : plannedSec(b); }
    function budgetSecFixed(b) { return reserveSec(b); }
    // A percent block's budget. Done percent blocks settle at their declared usage
    // (usedSec); the leftover (claim − all done usage) reflows to the non-done blocks
    // in proportion to their percent, so finishing a category hands its unused time
    // to the rest. With no done blocks this is identical to the old per-cent formula.
    function budgetSecPercent(b, remainingHours) {
        const totalPct = state.percent.reduce((s, x) => s + (x.percent || 0), 0);
        const claim = Math.max(0, remainingHours * 3600) * Math.min(100, totalPct) / 100;
        const doneUsed = state.percent.filter(x => x.done).reduce((s, x) => s + (x.usedSec || 0), 0);
        if (b.done) return b.usedSec || 0;
        const pool = Math.max(0, claim - doneUsed);
        const denom = state.percent.filter(x => !x.done).reduce((s, x) => s + (x.percent || 0), 0);
        return denom > 0 ? pool * (b.percent || 0) / denom : 0;
    }

    /* ── "Start from NOW" reflow.
       Fixed/time blocks are NOT taken into account. The reflow pool is the wall-clock
       time from now → bed, minus ALL currently-tracked (spent) time across every block.
       That pool is split across the non-done percent categories in proportion to their
       percent, so the remainder of the day fills now→bed with the flexible allocations
       only. Done percent blocks are settled (excluded — their used time is already in
       the spent total). Returns { allocs: id→sec, remainingSec(pool), totalSpentSec, dropped }. ── */
    function computeNowAllocations(remainingHours) {
        const { bed } = dayBoundsMin();
        const wallLeftSec = Math.max(0, (bed - nowMin()) * 60);   // wall-clock now → bed
        const all = [...state.fixed, ...state.percent];
        const totalSpentSec = all.reduce((s, b) => s + spentSec(b), 0);
        const pool = Math.max(0, wallLeftSec - totalSpentSec);   // left after all tracked time
        const recipients = state.percent.filter(b => !b.done);
        const denom = recipients.reduce((s, b) => s + (b.percent || 0), 0);
        const allocs = {};
        state.percent.forEach(b => {
            allocs[b.id] = (!b.done && denom > 0) ? pool * (b.percent || 0) / denom : 0;
        });
        return { allocs, remainingSec: pool, totalSpentSec, dropped: [] };
    }

    /* Shared budget/elapsed pair for a row, zen card, results row, and segment.
       NOW mode swaps in the resplit slice, but the spent counter keeps counting
       up from zero — the total time actually spent stays consistent between modes. */
    function rowBudget(b, isPercent, remainingHours) {
        if (state.nowMode && liveAllocs && isPercent) {
            // NOW reflow applies to percent blocks only; fixed blocks fall through to
            // their plan budget (NOW doesn't take time blocks into account).
            return { budget: liveAllocs.allocs[b.id] || 0, secAgainst: spentSec(b) };
        }
        return {
            budget: isPercent ? budgetSecPercent(b, remainingHours) : budgetSecFixed(b),
            secAgainst: spentSec(b),
        };
    }

    // Color carries state: on-track = base, approaching budget = amber, over = red.
    function ratioColor(base, budgetSec, actualSec) {
        if (budgetSec <= 0) return actualSec > 0 ? '#ff4d4d' : base;
        const r = actualSec / budgetSec;
        if (r >= 1) return '#ff4d4d';
        if (r >= 0.85) return '#ffd166';
        return base;
    }
    // Done blocks read as finished (green) — unless they ran over their planned
    // budget, in which case they stay red like any over-spend.
    function displayColor(b, budgetSec, actualSec) {
        if (b.done) return (plannedSec(b) > 0 && actualSec > plannedSec(b)) ? '#ff4d4d' : '#06d6a0';
        return ratioColor(b.color, budgetSec, actualSec);
    }

    // --- Formatting ---
    function formatHumanTime(totalSeconds) {
        if (totalSeconds <= 0) return "0 mins";
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        let result = [];
        if (h > 0) result.push(`${h} hour${h > 1 ? 's' : ''}`);
        if (m > 0) result.push(`${m} min${m > 1 ? 's' : ''}`);
        return result.join(' ') || "0 mins";
    }
    function formatDigitalTime(seconds) {
        seconds = Math.max(0, Math.floor(seconds));
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    function formatCompact(totalSeconds) {
        totalSeconds = Math.max(0, Math.floor(totalSeconds));
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        if (h > 0 && m > 0) return `${h}h ${m}m`;
        if (h > 0) return `${h}h`;
        if (m > 0) return `${m}m`;
        return '0m';
    }
    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // --- Add / remove ---
    function addFixed() {
        const b = { id: uid(), name: 'New Block', hours: 1, time: '', done: false, banked: 0, startedAt: null, color: pickColor(), alarmed: false, intervals: [] };
        state.fixed.push(b);
        save(); renderStructure();
        requestAnimationFrame(() => openEditSheet(b, 'fixed'));
    }
    function addPercent() {
        const b = { id: uid(), name: 'New Cat', percent: 0, banked: 0, startedAt: null, color: pickColor(), alarmed: false, intervals: [] };
        state.percent.push(b);
        save(); renderStructure();
        requestAnimationFrame(() => openEditSheet(b, 'percent'));
    }
    function removeBlock(listKey, id) {
        const list = state[listKey];
        const idx = list.findIndex(x => x.id === id);
        if (idx < 0) return;
        const block = list[idx];
        stopBlock(block);            // bank whatever was running so undo preserves it
        list.splice(idx, 1);
        save(); renderStructure();
        showUndo(listKey, idx, block);
    }
    function showUndo(listKey, idx, block) {
        undoState = { listKey, idx, block };
        showToast(`Removed “${block.name}”`, true);
        clearTimeout(undoTimer);
        undoTimer = setTimeout(() => { undoState = null; hideToast(); }, 6000);
    }
    function doUndo() {
        if (!undoState) return;
        const { listKey, idx, block } = undoState;
        state[listKey].splice(idx, 0, block);
        undoState = null;
        clearTimeout(undoTimer);
        hideToast();
        save(); renderStructure();
    }

    // --- Toast (shared by undo / alarm) ---
    function showToast(label, withUndo) {
        const toast = document.getElementById('toast');
        document.getElementById('toastLabel').textContent = label;
        document.getElementById('toastUndo').classList.toggle('hidden', !withUndo);
        toast.classList.add('show');
        clearTimeout(toastTimer);
    }
    function hideToast() {
        document.getElementById('toast').classList.remove('show');
        clearTimeout(toastTimer);
    }

    // --- Field updates (no structural rebuild — preserves focus while typing) ---
    function updateField(listKey, id, field, value) {
        const b = state[listKey].find(x => x.id === id);
        if (!b) return;
        if (field === 'hours' || field === 'percent') {
            b[field] = parseFloat(value) || 0;
            b.alarmed = false;   // editing the budget re-arms the alarm
        } else {
            b[field] = value;
        }
        save();
        updateLive();
    }

    // --- Rendering ---
    function buildRow(listKey, b, isPercent) {
        const row = document.createElement('div');
        row.className = 'category-row ' + (isPercent ? 'is-percent' : 'is-fixed');
        row.dataset.id = b.id;

        const name = document.createElement('input');
        name.type = 'text'; name.value = b.name;
        if (state.mode === 'run') name.readOnly = true;
        name.addEventListener('input', () => updateField(listKey, b.id, 'name', name.value));

        const num = document.createElement('input');
        num.type = 'number'; num.min = 0; num.step = isPercent ? 1 : 0.25;
        num.value = isPercent ? b.percent : b.hours;
        num.placeholder = isPercent ? '%' : 'hrs';
        num.addEventListener('input', () => updateField(listKey, b.id, isPercent ? 'percent' : 'hours', num.value));

        // Fixed blocks only: an optional start time-of-day that anchors the bar.
        let time = null;
        if (!isPercent) {
            time = document.createElement('input');
            time.type = 'time'; time.value = b.time || '';
            time.title = 'Start time of day (optional — anchors this block on the timeline)';
            if (state.mode === 'run') time.readOnly = true;
            time.addEventListener('input', () => updateField(listKey, b.id, 'time', time.value));
        }

        const disp = document.createElement('div');
        disp.className = 'timer-display';
        const dispElapsed = document.createElement('div');
        dispElapsed.className = 'td-elapsed';
        const dispBudget = document.createElement('div');
        dispBudget.className = 'td-budget';
        disp.append(dispElapsed, dispBudget);

        const btn = document.createElement('button');
        btn.className = 'btn-timer';
        btn.addEventListener('click', () => toggleBlock(listKey, b.id));

        // DONE button for every block. Fixed: toggles done (releases leftover planned
        // time to the percent splits). Percent: opens a slider to declare time used, then
        // settles and reflows the leftover to the other percent categories (tap again to
        // undo). stopPropagation so tapping it in run mode doesn't also toggle the timer.
        let doneBtn = null;
        doneBtn = document.createElement('button');
        doneBtn.className = 'btn-done';
        doneBtn.title = isPercent
            ? 'Mark done — declare time used and reflow the rest to other categories (tap again to undo)'
            : 'Mark done — release any leftover time to your other categories (tap again to undo)';
        doneBtn.addEventListener('click', (e) => {
            e.stopPropagation(); ensureAudio();
            if (isPercent) { b.done ? toggleDonePercent(b) : openDoneSlider(b); }
            else toggleDone(b);
        });
        doneBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); });   // don't start a hold-to-edit

        const rm = document.createElement('button');
        rm.className = 'btn-remove'; rm.textContent = '×';
        rm.addEventListener('click', () => removeBlock(listKey, b.id));

        // Mobile edit-mode only: a chevron that expands the row to reveal the
        // secondary fields (time/hours/buttons) at full size. Hidden on desktop
        // and in run mode via CSS, so it never affects the grid layouts there.
        const chev = document.createElement('button');
        chev.className = 'chevron';
        chev.type = 'button';
        chev.setAttribute('aria-label', 'Expand category fields');
        chev.setAttribute('aria-expanded', 'false');
        chev.textContent = '▾';
        chev.addEventListener('click', (e) => {
            e.stopPropagation();
            // Only one row expanded at a time.
            document.querySelectorAll('.category-row.expanded')
                .forEach(r => { if (r !== row) { r.classList.remove('expanded'); r.querySelector('.chevron')?.setAttribute('aria-expanded', 'false'); } });
            const willExpand = !row.classList.contains('expanded');
            row.classList.toggle('expanded', willExpand);
            chev.setAttribute('aria-expanded', willExpand ? 'true' : 'false');
        });

        // Per-row progress bar (fill = block color, grows with elapsed/budget)
        const progress = document.createElement('div');
        progress.className = 'progress';
        const fill = document.createElement('div');
        fill.className = 'progress-fill';
        progress.appendChild(fill);

        row.append(name, num, disp, btn, rm, chev, progress);
        if (time) row.insertBefore(time, num);   // fixed rows: name | time | hrs | …
        if (doneBtn) row.insertBefore(doneBtn, rm);   // … start/stop | Done | remove

        // Hold-to-edit: a long press (~450ms) opens the edit sheet; a quick tap
        // toggles the timer. Movement past a small threshold cancels the hold so
        // vertical page scrolling still works on touch. Done button is excluded
        // (it has its own click handler and stopPropagation).
        let holdTimer = null, cueTimer = null, held = false, moved = false, sx = 0, sy = 0;
        const clearHold = () => { clearTimeout(holdTimer); clearTimeout(cueTimer); holdTimer = null; cueTimer = null; row.classList.remove('holding'); };
        row.addEventListener('pointerdown', (e) => {
            if (e.target.closest('.btn-done')) return;     // Done handles itself
            held = false; moved = false;
            sx = e.clientX; sy = e.clientY;
            cueTimer = setTimeout(() => { row.classList.add('holding'); }, 150);   // tactile-ish cue that the hold is registering
            holdTimer = setTimeout(() => {
                held = true;
                row.classList.remove('holding');
                if (navigator.vibrate) try { navigator.vibrate(12); } catch (e) {}
                openEditSheet(b, listKey);
            }, 450);
        });
        row.addEventListener('pointermove', (e) => {
            if (!holdTimer) return;
            if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) {
                moved = true; clearHold();
            }
        });
        const endPress = (e) => {
            if (!holdTimer && !held && !moved) return;   // nothing started here
            const wasHeld = held;
            clearHold();
            if (wasHeld) return;                         // hold already opened the sheet
            if (moved) return;                            // was a scroll/drag
            // clean quick tap → toggle the timer
            e.preventDefault();
            ensureAudio();
            toggleBlock(listKey, b.id);
        };
        row.addEventListener('pointerup', endPress);
        row.addEventListener('pointercancel', clearHold);

        // Keyboard: the row is a button — Enter opens the edit sheet, Space toggles
        // the timer. Keeps the hold-to-edit flow reachable without a long-press.
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', 'Edit ' + b.name);
        row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); openEditSheet(b, listKey); }
            else if (e.key === ' ') { e.preventDefault(); ensureAudio(); toggleBlock(listKey, b.id); }
        });

        return row;
    }

    function renderStructure() {
        const fC = document.getElementById('fixedContainer');
        const pC = document.getElementById('percentContainer');
        const tlSegs = document.getElementById('tlSegs');
        const tlBlobs = document.getElementById('tlBlobs');
        const tlTicks = document.getElementById('tlTicks');
        fC.innerHTML = ''; pC.innerHTML = ''; tlSegs.innerHTML = ''; tlBlobs.innerHTML = '';
        for (const k in rowEls) delete rowEls[k];
        for (const k in segEls) delete segEls[k];
        for (const k in blobEls) delete blobEls[k];

        const attach = (container, listKey, isPercent) => {
            state[listKey].forEach(b => {
                const row = buildRow(listKey, b, isPercent);
                container.appendChild(row);
                rowEls[b.id] = {
                    row,
                    timer: row.querySelector('.timer-display'),
                    timerElapsed: row.querySelector('.td-elapsed'),
                    timerBudget: row.querySelector('.td-budget'),
                    btn: row.querySelector('.btn-timer'),
                    doneBtn: row.querySelector('.btn-done'),
                    progress: row.querySelector('.progress'),
                    progressFill: row.querySelector('.progress-fill'),
                };
                const seg = document.createElement('div');
                seg.className = 'segment';
                const fill = document.createElement('div');
                fill.className = 'segment-fill';
                seg.appendChild(fill);
                tlSegs.appendChild(seg);
                segEls[b.id] = seg;
                seg._fill = fill;   // cached on the seg, reuses segEls
            });
        };
        attach(fC, 'fixed', false);
        attach(pC, 'percent', true);

        freeSeg = document.createElement('div');
        freeSeg.className = 'segment free';
        freeSeg.style.borderBottom = '2px solid transparent';
        tlSegs.appendChild(freeSeg);

        renderTicks(tlTicks);
        updateLive();
    }

    /* Hour ticks under the bar: wake, bed, and a label every ~2h in between. */
    function renderTicks(tlTicks) {
        tlTicks.innerHTML = '';
        const { wake, bed, len } = dayBoundsMin();
        const step = len > 6 * 60 ? 120 : 60;   // ~2h labels for long days, 1h for short
        const fmt = m => {
            const h24 = Math.floor(m / 60) % 24, m60 = m % 60;
            const ampm = h24 < 12 ? 'a' : 'p';
            const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
            return h12 + (m60 === 0 ? '' : ':' + String(m60).padStart(2, '0')) + ampm;
        };
        for (let m = wake; m <= bed; m += step) {
            const t = document.createElement('div');
            t.className = 'tl-tick';
            t.style.left = ((m - wake) / len * 100) + '%';
            t.textContent = fmt(m);
            tlTicks.appendChild(t);
        }
        // Always label bed exactly.
        const end = document.createElement('div');
        end.className = 'tl-tick tl-tick-end';
        end.style.left = '100%';
        end.textContent = fmt(bed % 1440);
        tlTicks.appendChild(end);
    }

    function updateRow(b, isPercent, remainingHours) {
        const e = rowEls[b.id];
        if (!e) return;
        const sec = elapsedOf(b);
        const running = !!b.startedAt;
        const runMode = state.mode === 'run';

        // NOW mode → resplit slice + running elapsed; else plan target + full elapsed.
        const { budget, secAgainst } = rowBudget(b, isPercent, remainingHours);

        // Big display: elapsed in edit mode, remaining in run mode
        const shown = runMode ? Math.max(0, budget - secAgainst) : sec;
        e.timerElapsed.textContent = formatDigitalTime(shown);
        const done = !!b.done;
        e.timerBudget.textContent = runMode
            ? (done ? 'done · ' + formatCompact(secAgainst)
                    : formatCompact(secAgainst) + ' of ' + formatCompact(budget))
            : (done ? 'done · ' + formatCompact(sec) : 'of ' + formatCompact(budget));
        e.timerElapsed.style.color = displayColor(b, budget, secAgainst);
        e.row.classList.toggle('active', running);
        e.row.classList.toggle('done', done);
        e.row.classList.toggle('alarm', !!b.alarmed);
        // Running row lights up in its own identity color; idle falls back to the section rail.
        e.row.style.borderLeftColor = running ? b.color : (done ? '#06d6a0' : '');
        e.row.style.borderLeftStyle = (running || done) ? 'solid' : '';
        e.btn.classList.toggle('running', running);
        e.btn.textContent = running ? 'Stop' : 'Start';
        if (e.doneBtn) {
            e.doneBtn.classList.toggle('done', done);
            e.doneBtn.textContent = done ? 'Undo' : 'Done';
        }

        // Progress bar: fill IS the block color and grows with elapsed/budget.
        // Track is a faded tint of the same color; fill turns amber near, red over.
        const pct = budget > 0 ? Math.min(100, (secAgainst / budget) * 100) : (secAgainst > 0 ? 100 : 0);
        e.progressFill.style.width = pct + '%';
        e.progressFill.style.backgroundColor = displayColor(b, budget, secAgainst);
        e.progress.style.background = fade(b.color);
        applyStripes(e.progressFill, budget, secAgainst);   // pills read used-time just like the timeline segments

        // Alarm: crossed budget while running, fires once.
        if (running && budget > 0 && secAgainst >= budget && !b.alarmed) {
            b.alarmed = true;
            triggerAlarm(b);
        }
    }

    // Faded tint of a hex color (track = base color at ~13% alpha over dark bg).
    function fade(hex) {
        if (!hex || hex[0] !== '#') return 'rgba(255,255,255,0.06)';
        const h = hex.length === 4
            ? '#' + hex[1]+hex[1] + hex[2]+hex[2] + hex[3]+hex[3]
            : hex;
        return h + '22';
    }

    /* Same density-growing diagonal stripes the timeline segments use, applied to
       any colored element (a segment fill OR a pill progress fill). r=0 → none;
       r=1 → tight dark stripes. This is how "used time" is painted on the bar, and
       now on the pills too so they read the same. Do NOT transition background-image
       (it must update instantly each tick or the stripes smear). */
    function applyStripes(el, budgetSec, secAgainst) {
        const r = budgetSec > 0 ? Math.min(1, secAgainst / budgetSec) : (secAgainst > 0 ? 1 : 0);
        if (r <= 0) { el.style.backgroundImage = 'none'; return; }
        const period = Math.max(4, 40 * (1 - r) + 4);   // sparse (40px) → dense (4px) as it fills
        const a = (0.22 * r).toFixed(2);
        const half = (period / 2).toFixed(1);
        el.style.backgroundImage =
            `repeating-linear-gradient(45deg, rgba(0,0,0,${a}) 0, rgba(0,0,0,${a}) ${half}px, transparent ${half}px, transparent ${period.toFixed(1)}px)`;
    }

    function recalc() {
        const bank = bankHours();
        const totalFixed = state.fixed.reduce((s, b) => s + reserveSec(b) / 3600, 0);
        const remaining = Math.max(0, bank - totalFixed);
        document.getElementById('remainingCaption').textContent =
            remaining > 0 ? 'splitting ' + formatHumanTime(remaining * 3600) + ' after fixed blocks'
                          : 'no time left after fixed blocks';
        let totalPercent = 0;
        state.percent.forEach(b => totalPercent += (b.percent || 0));

        // ── Timeline geometry. The bar spans wake→bed; segments are absolutely
        // positioned. In plan mode a fixed block with a start time anchors at that
        // wall-clock position (otherwise it flows from the cursor); percent blocks
        // fill the remainder. In NOW mode everything flows now→bed as resplit slices. ──
        const { wake, len } = dayBoundsMin();
        const dayLenH = dayLengthHours();
        const dayLenSec = dayLenH * 3600;
        const npct = nowPctOfDay();
        let cursor = state.nowMode ? npct : 0;

        // Stripes + a growing fill both encode used/budget. The segment is the dim
        // track (the budget span); the .segment-fill child is the bright bar that
        // "fills up" as time is spent — the same look the per-row pills use.
        const placeSeg = (b, leftPct, widthPct, budgetSec, secAgainst) => {
            const seg = segEls[b.id];
            if (!seg) return;
            const w = Math.max(0, widthPct);
            seg.style.left = leftPct + '%';
            seg.style.width = w + '%';
            seg.style.backgroundColor = fade(b.color);   // dim track
            seg.classList.toggle('done', !!b.done);
            seg.style.borderBottom = '2px solid ' + displayColor(b, budgetSec, secAgainst);
            const fillPct = budgetSec > 0 ? Math.min(100, (secAgainst / budgetSec) * 100)
                                          : (secAgainst > 0 ? 100 : 0);
            const fill = seg._fill;
            if (fill) {
                fill.style.width = fillPct + '%';
                fill.style.backgroundColor = displayColor(b, budgetSec, secAgainst);
                applyStripes(fill, budgetSec, secAgainst);
            }
            cursor = Math.max(cursor, leftPct + w);
        };

        // Anchored left% for a fixed block's start time (clamped to the day window).
        const fixedLeftPct = (b) => {
            if (!b.time) return cursor;
            let t = timeToMin(b.time);
            if (t < wake) t += 1440;            // past-midnight block in a wrapped day
            return len > 0 ? Math.max(0, Math.min(100, ((t - wake) / len) * 100)) : 0;
        };

        if (state.nowMode && liveAllocs) {
            // NOW mode: reflow slices of now→bed, percent only (fixed blocks excluded).
            state.percent.forEach(b => {
                const { budget, secAgainst } = rowBudget(b, true, remaining);
                const w = dayLenSec > 0 ? budget / dayLenSec * 100 : 0;
                placeSeg(b, cursor, w, budget, secAgainst);
                const seg = segEls[b.id];
                if (seg) seg.title = b.name + ' · NOW ' + formatHumanTime(budget) + ' · ' + formatHumanTime(secAgainst) + ' actual';
            });
        } else {
            // Plan mode: fixed blocks at their start time (or from the cursor), then
            // percent of the remainder.
            state.fixed.forEach(b => {
                const bsec = budgetSecFixed(b);   // = reserve: planned, or actual-once-done
                const w = dayLenSec > 0 ? (bsec / dayLenSec) * 100 : 0;
                const left = fixedLeftPct(b);
                placeSeg(b, left, w, bsec, elapsedOf(b));
                const seg = segEls[b.id];
                if (seg) seg.title = b.name + (b.time ? ' @ ' + formatClock(timeToMin(b.time)) : '') + (b.done ? ' · done' : '') + ': ' + formatHumanTime(bsec) + (b.done ? ' taken' : ' budget') + ' · ' + formatHumanTime(elapsedOf(b)) + ' actual';
            });
            state.percent.forEach(b => {
                const bsec = budgetSecPercent(b, remaining);
                const w = dayLenH > 0 ? (b.percent / 100) * (remaining / dayLenH) * 100 : 0;
                placeSeg(b, cursor, w, bsec, elapsedOf(b));
                const seg = segEls[b.id];
                if (seg) seg.title = b.name + ' (' + b.percent + '% = ' + formatHumanTime(bsec) + ' of remaining) · ' + formatHumanTime(elapsedOf(b)) + ' actual';
            });
        }

        // Free / unallocated slack fills whatever's left.
        freeSeg.style.left = cursor + '%';
        const freePct = Math.max(0, 100 - cursor);
        freeSeg.style.width = freePct + '%';
        const freeHours = (freePct / 100) * dayLenH;
        freeSeg.title = 'Free / unallocated: ' + formatHumanTime(freeHours * 3600);

        // NOW line + dim past track (past track shown only in NOW mode). The NOW
        // marker paints itself in the color of whatever timer is currently running
        // (most-recently-started wins in multitask); green when nothing is running.
        const nowLine = document.getElementById('tlNow');
        if (nowLine) {
            nowLine.style.left = npct + '%';
            const lbl = document.getElementById('tlNowLabel');
            if (lbl) {
                lbl.textContent = 'NOW ' + formatClock(nowMin());
                lbl.classList.toggle('edge-left', npct < 8);
                lbl.classList.toggle('edge-right', npct > 92);
            }
            const running = runningBlocks();
            let nowColor = null;
            if (running.length === 1) nowColor = running[0].color;
            else if (running.length > 1) nowColor = running.reduce((a, b) => (b.startedAt > a.startedAt ? b : a)).color;
            if (nowColor) nowLine.style.setProperty('--now-color', nowColor);
            else nowLine.style.removeProperty('--now-color');
        }
        const tlPast = document.getElementById('tlPast');
        if (tlPast) tlPast.style.width = (state.nowMode ? npct : 0) + '%';

        renderBlobs(npct);

        // Caption: NOW summary in NOW mode, plan summary otherwise.
        const caption = document.getElementById('vizCaption');
        if (state.nowMode && liveAllocs) {
            const parts = [formatHumanTime(liveAllocs.remainingSec) + ' left to split',
                           formatHumanTime(liveAllocs.totalSpentSec) + ' spent'];
            if (liveAllocs.dropped.length) parts.push(liveAllocs.dropped.join(', ') + ' over budget');
            caption.textContent = parts.join('  ·  ');
        } else {
            caption.textContent =
                formatHumanTime(remaining * 3600) + ' left to split  ·  ' + formatHumanTime(freeHours * 3600) + ' free';
        }

        document.getElementById('warning').style.display = totalPercent > 100 ? 'block' : 'none';
        buildResults(bank, remaining, totalPercent);
        return { bank, remaining, totalPercent };
    }

    /* Spent blobs: one per logged interval (finished + the live running one),
       clamped to today's [wake, now] window, positioned by wall-clock time. */
    function renderBlobs(npct) {
        const tlBlobs = document.getElementById('tlBlobs');
        if (!tlBlobs) return;
        const { startMs, lenMs } = dayWindowMs();
        const now = nowMs();
        const seen = new Set();
        [...state.fixed, ...state.percent].forEach(b => {
            const ivs = (Array.isArray(b.intervals) ? b.intervals : []).slice();
            if (b.startedAt) ivs.push({ s: b.startedAt, e: now });   // live running interval
            ivs.forEach((iv, i) => {
                let s = Math.max(iv.s, startMs);
                let e = Math.min(iv.e, now);          // blobs only in the past
                if (e <= s) return;                   // entirely outside window / future
                const key = b.id + ':' + i;
                seen.add(key);
                let el = blobEls[key];
                if (!el) {
                    el = document.createElement('div');
                    el.className = 'spent-blob';
                    el.style.backgroundColor = b.color;
                    tlBlobs.appendChild(el);
                    blobEls[key] = el;
                }
                el.style.left = ((s - startMs) / lenMs * 100) + '%';
                el.style.width = Math.max(0.5, (e - s) / lenMs * 100) + '%';
            });
        });
        // Drop blobs for intervals that no longer exist (block removed / day reset).
        for (const key in blobEls) {
            if (!seen.has(key)) { blobEls[key].remove(); delete blobEls[key]; }
        }
    }

    function dayWindowMs() {
        const { wake, len } = dayBoundsMin();
        const d = new Date(nowMs()); d.setHours(0, 0, 0, 0);
        return { startMs: d.getTime() + wake * 60000, lenMs: len * 60000 };
    }
    function formatClock(minSinceMidnight) {
        const m = ((minSinceMidnight % 1440) + 1440) % 1440;
        const h24 = Math.floor(m / 60), m60 = m % 60;
        const ampm = h24 < 12 ? 'AM' : 'PM';
        const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
        return h12 + ':' + String(m60).padStart(2, '0') + ' ' + ampm;
    }

    function buildResults(bank, remaining, totalPercent) {
        const list = document.getElementById('resultsList');
        // Rebuild only when the set of blocks changes (add/remove/undo);
        // otherwise update text in place so running timers don't churn the DOM.
        const sig = state.fixed.map(b => b.id).join(',') + '|' + state.percent.map(b => b.id).join(',');
        if (list.dataset.sig !== sig) {
            list.dataset.sig = sig;
            list.innerHTML = '';
            state.fixed.forEach(b => {
                const item = document.createElement('div');
                item.className = 'result-item';
                item.dataset.id = b.id;
                item.innerHTML = `<span>${escapeHtml(b.name)} (Fixed)</span><span><span class="budget-val" style="color:var(--text-dim)">Budget 0 mins</span> | <span class="time-val">Actual 0 mins</span></span>`;
                list.appendChild(item);
            });
            state.percent.forEach(b => {
                const item = document.createElement('div');
                item.className = 'result-item';
                item.dataset.id = b.id;
                item.innerHTML = `<span>${escapeHtml(b.name)} (0%)</span><span><span class="budget-val" style="color:var(--text-dim)">Budget 0 mins</span> | <span class="time-val">Actual 0 mins</span></span>`;
                list.appendChild(item);
            });
            const free = document.createElement('div');
            free.className = 'result-item free-row';
            free.innerHTML = `<span style="color:var(--text-dim)">Free of remaining / unallocated</span><span class="time-val" style="color:var(--text-dim)">0 mins</span>`;
            list.appendChild(free);
        }

        // Update text in place (no innerHTML churn while timers run)
        state.fixed.forEach(b => {
            const item = list.querySelector(`.result-item[data-id="${b.id}"]`);
            if (!item) return;
            const { budget, secAgainst } = rowBudget(b, false, remaining);
            item.querySelector('span:first-child').textContent = `${b.name} (Fixed${b.done ? ' · done' : ''})`;
            item.querySelector('.budget-val').textContent = `${b.done ? 'Taken' : 'Budget'} ${formatHumanTime(budget)}`;
            const tv = item.querySelector('.time-val');
            tv.textContent = `Actual ${formatHumanTime(secAgainst)}`;
            tv.style.color = displayColor(b, budget, secAgainst);
        });
        state.percent.forEach(b => {
            const item = list.querySelector(`.result-item[data-id="${b.id}"]`);
            if (!item) return;
            const { budget, secAgainst } = rowBudget(b, true, remaining);
            item.querySelector('span:first-child').textContent = `${b.name} (${b.percent}%${b.done ? ' · done' : ''})`;
            item.querySelector('.budget-val').textContent = `${b.done ? 'Used' : 'Budget'} ${formatHumanTime(budget)}`;
            const tv = item.querySelector('.time-val');
            tv.textContent = `Actual ${formatHumanTime(secAgainst)}`;
            tv.style.color = displayColor(b, budget, secAgainst);
        });
        const freeRow = list.querySelector('.free-row');
        const freeH = Math.max(0, remaining - remaining * Math.min(totalPercent, 100) / 100);
        if (freeRow) {
            freeRow.style.display = freeH > 0 ? '' : 'none';
            freeRow.querySelector('.time-val').textContent = formatHumanTime(freeH * 3600);
        }
    }

    function updateLive() {
        // Compute the resplit BEFORE recalc: recalc's NOW-mode timeline branch reads
        // liveAllocs, so it must be fresh, not one tick stale.
        liveAllocs = computeNowAllocations(remainingHours());
        const { remaining } = recalc();
        state.fixed.forEach(b => updateRow(b, false, remaining));
        state.percent.forEach(b => updateRow(b, true, remaining));
        updateZen();              // refresh zen cards in place while visible
        updateZenVisibility();    // auto-show/hide as timers start and stop
    }

    // --- Reset the day: zero out all time, keep the structure ---
    function resetDay() {
        [...state.fixed, ...state.percent].forEach(b => {
            b.banked = 0;
            b.startedAt = null;
            b.alarmed = false;
            b.intervals = [];
        });
        // A fresh day un-finishes percent categories (clear settled usage) so the
        // reflow starts clean. (Fixed `done` is left as-is — pre-existing behavior.)
        state.percent.forEach(b => { b.done = false; b.usedSec = 0; });
        state.nowMode = false;
        zenOpen = false;        // a fresh day starts with zen closed; a solo start reopens it
        updateZenVisibility();
        save();
        renderStructure();
    }

    // --- Alarm (beep + row pulse + toast, fires once per fill) ---
    let audioCtx = null;
    function ensureAudio() {
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') audioCtx.resume();
        } catch (e) {}
    }
    function beep(freq, dur, gain) {
        if (!audioCtx) return;
        try {
            const o = audioCtx.createOscillator(), g = audioCtx.createGain();
            o.type = 'sine'; o.frequency.value = freq; g.gain.value = gain;
            o.connect(g); g.connect(audioCtx.destination);
            const t = audioCtx.currentTime;
            o.start(t);
            g.gain.setValueAtTime(gain, t);
            g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
            o.stop(t + dur);
        } catch (e) {}
    }
    function alarmSound() {
        ensureAudio();
        beep(880, 0.22, 0.18);
        setTimeout(() => beep(660, 0.22, 0.18), 260);
        setTimeout(() => beep(990, 0.30, 0.18), 520);
    }
    function triggerAlarm(b) {
        alarmSound();
        showToast(`⏰ Time’s up: ${b.name} — tap the row to stop`, false);
        clearTimeout(toastTimer);
        toastTimer = setTimeout(hideToast, 4500);
        save();
    }

    // --- Run view is the home. There is no edit mode anymore; editing happens
    //     per-category through the hold-to-edit bottom-sheet. applyMode just pins
    //     the run-view class and keeps name inputs read-only (they're display labels). ---
    function applyMode() {
        document.getElementById('app').classList.add('mode-run');
        document.querySelectorAll('.category-row input[type="text"]').forEach(n => n.readOnly = true);
    }

    // --- Start from NOW: reflow the remainder (now → bed) across budgets ---
    // Engaging resplits the flexible pool from the current wall-clock time forward.
    // The total time actually spent keeps counting up, so switching modes never
    // resets a block's spent counter — it only changes the budget it is compared to.
    function applyNowLabel() {
        const btn = document.getElementById('nowBtn');
        if (!btn) return;
        btn.textContent = state.nowMode ? 'Plan' : 'Start from NOW';
        btn.setAttribute('aria-pressed', state.nowMode ? 'true' : 'false');
        btn.classList.toggle('active', state.nowMode);
    }
    function toggleNow() {
        state.nowMode = !state.nowMode;
        if (state.nowMode) {
            // Re-arm alarms against the new resplit budgets.
            [...state.fixed, ...state.percent].forEach(b => { b.alarmed = false; });
        }
        applyNowLabel();
        save(); updateLive();
    }

    // --- Zen mode: full-screen focus on whatever is running ---
    // The Zen button is a simple open/close toggle. Solo starts auto-open the
    // overlay; exiting (×, backdrop, Escape) closes it; the button reopens it.
    // State is ephemeral (not persisted) — a fresh page starts closed.
    let zenOpen = false;
    let zenSig = '';              // set of running ids currently rendered (avoids per-tick churn)

    function remainingHours() {
        const bank = bankHours();
        const totalFixed = state.fixed.reduce((s, b) => s + reserveSec(b) / 3600, 0);
        return Math.max(0, bank - totalFixed);
    }
    function runningBlocks() {
        return [...state.fixed, ...state.percent].filter(b => b.startedAt);
    }
    function updateZenVisibility() {
        const overlay = document.getElementById('zenOverlay');
        overlay.classList.toggle('show', zenOpen);
        overlay.setAttribute('aria-hidden', zenOpen ? 'false' : 'true');
        document.getElementById('zenBtn').classList.toggle('active', zenOpen);
        if (zenOpen) updateZen();
    }
    function updateZen() {
        const content = document.getElementById('zenContent');
        const running = runningBlocks();
        const sig = running.map(b => b.id).join(',');
        const remaining = remainingHours();
        const runMode = state.mode === 'run';

        // Rebuild structure only when the set of running timers changes.
        if (sig !== zenSig) {
            zenSig = sig;
            content.innerHTML = '';
            if (running.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'zen-empty';
                empty.textContent = 'No timers running';
                content.appendChild(empty);
            } else {
                running.forEach(b => {
                    const card = document.createElement('div');
                    card.className = 'zen-card';
                    card.dataset.id = b.id;
                    card.style.borderTopColor = b.color;
                    card.innerHTML =
                        '<div class="zen-name"></div>' +
                        '<div class="zen-time"></div>' +
                        '<div class="zen-sub"></div>' +
                        '<div class="zen-progress"><div class="zen-progress-fill"></div></div>';
                    content.appendChild(card);
                });
            }
        }

        // Update text in place every tick (no DOM churn while timers run).
        running.forEach(b => {
            const isPercent = state.percent.includes(b);
            const { budget, secAgainst } = rowBudget(b, isPercent, remaining);
            const card = content.querySelector(`.zen-card[data-id="${b.id}"]`);
            if (!card) return;
            const shown = runMode ? Math.max(0, budget - secAgainst) : secAgainst;
            card.querySelector('.zen-name').textContent = b.name;
            const time = card.querySelector('.zen-time');
            time.textContent = formatDigitalTime(shown);
            time.style.color = ratioColor(b.color, budget, secAgainst);
            card.querySelector('.zen-sub').textContent = runMode ? (b.startedAt ? 'left' : '') : 'of ' + formatCompact(budget);
            const pct = budget > 0 ? Math.min(100, (secAgainst / budget) * 100) : (secAgainst > 0 ? 100 : 0);
            const fill = card.querySelector('.zen-progress-fill');
            fill.style.width = pct + '%';
            fill.style.backgroundColor = ratioColor(b.color, budget, secAgainst);
            card.querySelector('.zen-progress').style.background = fade(b.color);
            card.classList.toggle('alarm', !!b.alarmed);
        });
    }
    // Zen button: toggle the overlay open/closed. Auto-pop is handled in startBlock.
    function toggleZen() {
        zenOpen = !zenOpen;
        updateZenVisibility();
    }
    // Page out of zen. Timers keep running; re-enter via the button or a fresh solo start.
    function exitZen() {
        zenOpen = false;
        updateZenVisibility();
    }

    // --- Hold-to-confirm modal ---
    const HOLD_MS = 1300;
    let holding = false;
    let completed = false;
    let holdTimer = null;

    function openResetModal() {
        document.getElementById('resetModal').classList.add('show');
        // Safe default: focus the non-destructive action.
        document.getElementById('modalCancel').focus();
    }
    function closeResetModal() {
        cancelHold();
        document.getElementById('resetModal').classList.remove('show');
    }
    function beginHold() {
        if (holding || completed) return;
        holding = true;
        document.getElementById('modalConfirm').classList.add('holding');
        holdTimer = setTimeout(finishHold, HOLD_MS);
    }
    function cancelHold() {
        if (completed) return;
        holding = false;
        clearTimeout(holdTimer);
        document.getElementById('modalConfirm').classList.remove('holding');
    }
    function finishHold() {
        completed = true;
        holding = false;
        const btn = document.getElementById('modalConfirm');
        btn.classList.add('complete');
        btn.querySelector('.htc-label').textContent = 'New day started';
        setTimeout(() => {
            resetDay();
            closeResetModal();
            // restore the confirm button for next time
            btn.classList.remove('holding', 'complete');
            btn.querySelector('.htc-label').textContent = 'Hold to start new day';
            completed = false;
        }, 600);
    }

    // --- Done slider modal (percent categories) ---
    let pendingDone = null;        // the percent block the user is settling
    let doneSliderEl = null, doneValEl = null, doneModalEl = null;

    function openDoneSlider(b) {
        pendingDone = b;
        if (!doneModalEl) {
            doneModalEl = document.getElementById('doneModal');
            doneSliderEl = document.getElementById('doneSlider');
            doneValEl = document.getElementById('doneVal');
        }
        document.getElementById('doneTitle').textContent = `Mark “${b.name}” done`;
        const budgetMin = Math.floor(budgetSecPercent(b, remainingHours()) / 60);
        const elapsedMin = Math.floor(elapsedOf(b) / 60);
        const maxMin = Math.max(budgetMin, elapsedMin, 0);
        doneSliderEl.min = 0; doneSliderEl.max = maxMin; doneSliderEl.step = 1;
        doneSliderEl.value = Math.min(elapsedMin, maxMin);
        updateDoneVal();
        doneModalEl.classList.add('show');
        document.getElementById('doneCancel').focus();
    }
    function updateDoneVal() {
        if (doneValEl) doneValEl.textContent = formatHumanTime((+doneSliderEl.value || 0) * 60);
    }
    function closeDoneModal() {
        if (doneModalEl) doneModalEl.classList.remove('show');
        pendingDone = null;
    }
    function confirmDone() {
        const b = pendingDone;
        if (!b) { closeDoneModal(); return; }
        const sec = (+doneSliderEl.value || 0) * 60;
        if (b.startedAt) stopBlock(b);          // stop any running timer before settling
        b.done = true;
        b.usedSec = sec;
        save();
        closeDoneModal();
        updateLive();
    }
    // Undo: un-finish a percent category and return its leftover to the reflow.
    function toggleDonePercent(b) {
        b.done = false;
        b.usedSec = 0;
        save();
        updateLive();
    }

    // --- Hold-to-edit bottom-sheets (per-category + day window) ---
    // The app lives in the run view; editing is a mobile bottom-sheet with scroll
    // wheels for time and a slider for percentages. Built dynamically per block.
    const WHEEL_ITEM_H = 40;
    let editCtx = null;       // { b, listKey, wheels..., apply() }
    let dayCtx = null;

    /* A scroll-snap wheel. labels[] is the displayed text per index; the caller
       maps the selected index back to a semantic value. Returns { el, setIndex }. */
    function createWheel(labels, startIndex, onIndex) {
        const wrap = document.createElement('div');
        wrap.className = 'wheel';
        const addSpacer = () => { const s = document.createElement('div'); s.className = 'wheel-item wheel-spacer'; wrap.appendChild(s); };
        addSpacer(); addSpacer();
        labels.forEach((lbl, i) => {
            const it = document.createElement('div');
            it.className = 'wheel-item';
            it.textContent = lbl;
            it.dataset.i = i;
            wrap.appendChild(it);
        });
        addSpacer(); addSpacer();
        let cur = startIndex;
        let raf = 0;
        const read = () => {
            const i = Math.max(0, Math.min(labels.length - 1, Math.round(wrap.scrollTop / WHEEL_ITEM_H)));
            if (i !== cur) { cur = i; onIndex(i); }
        };
        wrap.addEventListener('scroll', () => { read(); });
        requestAnimationFrame(() => { wrap.scrollTop = startIndex * WHEEL_ITEM_H; });
        return { el: wrap, setIndex(i) { cur = i; wrap.scrollTop = i * WHEEL_ITEM_H; } };
    }
    const range = (n) => Array.from({ length: n }, (_, i) => i);
    const HOUR_LABELS = range(24).map(h => String(h));           // 0–23
    const MIN_LABELS  = range(12).map(m => String(m * 5));        // 0,5,…,55
    const pad2 = (n) => String(n).padStart(2, '0');
    function timeToHM(t) {                                       // "08:30" → {h:8, m:30}
        if (typeof t !== 'string' || !t.includes(':')) return { h: 0, m: 0 };
        const [h, m] = t.split(':').map(n => parseInt(n, 10) || 0);
        return { h: Math.max(0, Math.min(23, h)), m: Math.max(0, Math.min(55, m)) };
    }

    function openSheet(backdropId) {
        const bd = document.getElementById(backdropId);
        bd.classList.add('show');
    }
    function closeSheet(backdropId) {
        document.getElementById(backdropId).classList.remove('show');
    }
    function buildSectionLabel(text) {
        const l = document.createElement('div');
        l.className = 'sheet-label';
        l.textContent = text;
        return l;
    }
    function buildWheelGroup(labelText, wheel) {
        const g = document.createElement('div');
        g.className = 'wheel-group';
        g.appendChild(buildSectionLabel(labelText));
        const wrap = document.createElement('div');
        wrap.className = 'wheel-wrap';
        const band = document.createElement('div'); band.className = 'wheel-band';
        wrap.appendChild(wheel.el);
        wrap.appendChild(band);
        g.appendChild(wrap);
        return g;
    }

    function openEditSheet(b, listKey) {
        const isPercent = listKey === 'percent';
        editCtx = { b, listKey, trigger: document.activeElement };   // restore focus here on close
        document.getElementById('editTitle').textContent = 'Edit';
        const body = document.getElementById('editBody');
        body.innerHTML = '';

        // Name
        const nameWrap = document.createElement('div');
        nameWrap.className = 'sheet-field';
        nameWrap.appendChild(buildSectionLabel('Name'));
        const nameInput = document.createElement('input');
        nameInput.type = 'text'; nameInput.value = b.name; nameInput.className = 'sheet-input';
        nameInput.maxLength = 40;
        nameInput.addEventListener('input', () => { b.name = nameInput.value; save(); updateLive(); });
        nameWrap.appendChild(nameInput);
        body.appendChild(nameWrap);

        if (isPercent) {
            // Percent slider
            const pctWrap = document.createElement('div');
            pctWrap.className = 'sheet-field';
            pctWrap.appendChild(buildSectionLabel('Percentage of remaining'));
            const readout = document.createElement('div');
            readout.className = 'pct-readout'; readout.textContent = (b.percent || 0) + '%';
            const slider = document.createElement('input');
            slider.type = 'range'; slider.min = 0; slider.max = 100; slider.step = 1;
            slider.value = b.percent || 0; slider.className = 'pct-slider';
            slider.addEventListener('input', () => {
                b.percent = parseInt(slider.value, 10) || 0;
                b.alarmed = false;
                readout.textContent = b.percent + '%';
                save(); updateLive();
            });
            pctWrap.appendChild(readout);
            pctWrap.appendChild(slider);
            body.appendChild(pctWrap);
        } else {
            // Hours + minutes wheels for the budget
            const totalMin = Math.round((b.hours || 0) * 60);
            let h = Math.min(23, Math.floor(totalMin / 60));
            let m = Math.min(55, (totalMin % 60));
            // round minutes to nearest 5
            m = Math.round(m / 5) * 5; if (m >= 60) { m = 0; h = Math.min(23, h + 1); }
            const apply = () => {
                b.hours = h + m / 60;
                b.alarmed = false;
                save(); updateLive();
            };
            const hWheel = createWheel(HOUR_LABELS, h, (i) => { h = i; apply(); });
            const mWheel = createWheel(MIN_LABELS, m / 5, (i) => { m = i * 5; apply(); });
            body.appendChild(buildWheelGroup('Hours', hWheel));
            body.appendChild(buildWheelGroup('Minutes', mWheel));

            // Optional start-time-of-day anchor
            const anchorWrap = document.createElement('div');
            anchorWrap.className = 'sheet-field anchor-field';
            const anchorRow = document.createElement('label');
            anchorRow.className = 'anchor-row';
            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.checked = !!b.time;
            const cbLabel = document.createElement('span');
            cbLabel.textContent = 'Anchor to a start time';
            anchorRow.appendChild(cb); anchorRow.appendChild(cbLabel);
            anchorWrap.appendChild(anchorRow);

            const startWheelsHost = document.createElement('div');
            startWheelsHost.className = 'anchor-wheels' + (cb.checked ? '' : ' hidden');
            let sh = timeToHM(b.time).h, sm = Math.round(timeToHM(b.time).m / 5) * 5;
            const applyStart = () => {
                if (!cb.checked) { b.time = ''; save(); updateLive(); return; }
                b.time = pad2(sh) + ':' + pad2(sm);
                save(); updateLive();
            };
            const shWheel = createWheel(HOUR_LABELS, sh, (i) => { sh = i; applyStart(); });
            const smWheel = createWheel(MIN_LABELS, sm / 5, (i) => { sm = i * 5; applyStart(); });
            startWheelsHost.appendChild(buildWheelGroup('Start hour', shWheel));
            startWheelsHost.appendChild(buildWheelGroup('Start min', smWheel));
            anchorWrap.appendChild(startWheelsHost);
            cb.addEventListener('change', () => {
                startWheelsHost.classList.toggle('hidden', !cb.checked);
                applyStart();
            });
            body.appendChild(anchorWrap);
        }

        // Delete: two-tap confirm so a misclick in the sheet can't drop a category.
        const delBtn = document.getElementById('editDelete');
        let armed = false, armTimer = null;
        delBtn.onclick = () => {
            if (!armed) {
                armed = true;
                delBtn.textContent = 'Tap again to delete';
                delBtn.classList.add('armed');
                armTimer = setTimeout(() => { armed = false; delBtn.textContent = 'Delete category'; delBtn.classList.remove('armed'); }, 3000);
                return;
            }
            clearTimeout(armTimer);
            removeBlock(listKey, b.id);
            closeEditSheet();
        };
        // Reset the delete button label for next time when the sheet closes.
        openSheet('editBackdrop');
        // focus + select the name input shortly after the sheet is shown (select so
        // typing replaces the placeholder for newly added categories).
        requestAnimationFrame(() => { try { nameInput.focus({ preventScroll: true }); nameInput.select(); } catch (e) {} });
    }
    function closeEditSheet() {
        closeSheet('editBackdrop');
        const delBtn = document.getElementById('editDelete');
        if (delBtn) { delBtn.textContent = 'Delete category'; delBtn.classList.remove('armed'); }
        const t = editCtx && editCtx.trigger;
        editCtx = null;
        if (t && t.focus) try { t.focus({ preventScroll: true }); } catch (e) {}
    }

    function openDaySheet() {
        const body = document.getElementById('dayBody');
        body.innerHTML = '';

        const wh = timeToHM(state.wake), bh = timeToHM(state.bed);
        let wH = wh.h, wM = Math.round(wh.m / 5) * 5;
        let bH = bh.h, bM = Math.round(bh.m / 5) * 5;
        const dayLenEl = document.createElement('div');
        dayLenEl.className = 'day-readout';

        const applyDay = () => {
            state.wake = pad2(wH) + ':' + pad2(wM);
            state.bed  = pad2(bH) + ':' + pad2(bM);
            save();
            renderTicks(document.getElementById('tlTicks'));
            updateLive();
            dayLenEl.textContent = formatHumanTime(dayLengthHours() * 3600) + ' to spend';
        };

        const wakeGroup = document.createElement('div');
        wakeGroup.className = 'sheet-field';
        wakeGroup.appendChild(buildSectionLabel('Wake'));
        const wakeWheels = document.createElement('div'); wakeWheels.className = 'wheel-pair';
        wakeWheels.appendChild(buildWheelGroup('Hour', createWheel(HOUR_LABELS, wH, (i) => { wH = i; applyDay(); })));
        wakeWheels.appendChild(buildWheelGroup('Min', createWheel(MIN_LABELS, wM / 5, (i) => { wM = i * 5; applyDay(); })));
        wakeGroup.appendChild(wakeWheels);
        body.appendChild(wakeGroup);

        const bedGroup = document.createElement('div');
        bedGroup.className = 'sheet-field';
        bedGroup.appendChild(buildSectionLabel('Bed'));
        const bedWheels = document.createElement('div'); bedWheels.className = 'wheel-pair';
        bedWheels.appendChild(buildWheelGroup('Hour', createWheel(HOUR_LABELS, bH, (i) => { bH = i; applyDay(); })));
        bedWheels.appendChild(buildWheelGroup('Min', createWheel(MIN_LABELS, bM / 5, (i) => { bM = i * 5; applyDay(); })));
        bedGroup.appendChild(bedWheels);
        body.appendChild(bedGroup);

        body.appendChild(dayLenEl);
        dayLenEl.textContent = formatHumanTime(dayLengthHours() * 3600) + ' to spend';   // readout only — don't mutate state until a wheel moves

        // Multitask toggle
        const mtWrap = document.createElement('div');
        mtWrap.className = 'sheet-field toggle-field';
        const switchLabel = document.createElement('label');
        switchLabel.className = 'switch';
        const mtInput = document.createElement('input');
        mtInput.type = 'checkbox'; mtInput.checked = state.multitask;
        const track = document.createElement('span'); track.className = 'track';
        switchLabel.appendChild(mtInput); switchLabel.appendChild(track);
        const mtText = document.createElement('span');
        mtText.className = 'toggle-label';
        mtText.textContent = 'Allow overlapping timers (off = starting one stops the rest)';
        mtWrap.appendChild(switchLabel); mtWrap.appendChild(mtText);
        mtInput.addEventListener('change', () => {
            state.multitask = mtInput.checked;
            updateZenVisibility(); save();
        });
        body.appendChild(mtWrap);

        openSheet('dayBackdrop');
    }
    function closeDaySheet() { closeSheet('dayBackdrop'); }

    // --- Init ---
    function init() {
        const had = load();
        if (!had) seedDefaults();
        // If loaded an old save with no color assignment, ensure colors exist.
        if (had) reassignColorsIfNeeded();
        applyMode();
        applyNowLabel();

        // Day window is edited through a bottom-sheet opened by tapping the
        // timeline (the wake→bed bar at the top of the run view).
        const visualizer = document.getElementById('visualizer');
        visualizer.addEventListener('click', openDaySheet);
        visualizer.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDaySheet(); }
        });
        // The caption is a sibling of the bar; wire it to the same day-window sheet.
        const vizCaption = document.getElementById('vizCaption');
        if (vizCaption) vizCaption.addEventListener('click', openDaySheet);

        document.getElementById('nowBtn').addEventListener('click', () => { ensureAudio(); toggleNow(); });

        document.getElementById('addFixedBtn').addEventListener('click', addFixed);
        document.getElementById('addPercentBtn').addEventListener('click', addPercent);
        document.getElementById('toastUndo').addEventListener('click', doUndo);

        // Bottom-sheet open/close wiring (per-category edit + day window).
        document.getElementById('editClose').addEventListener('click', closeEditSheet);
        document.getElementById('dayClose').addEventListener('click', closeDaySheet);
        const editBackdrop = document.getElementById('editBackdrop');
        const dayBackdrop = document.getElementById('dayBackdrop');
        editBackdrop.addEventListener('click', (e) => { if (e.target === editBackdrop) closeEditSheet(); });
        dayBackdrop.addEventListener('click', (e) => { if (e.target === dayBackdrop) closeDaySheet(); });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (editBackdrop.classList.contains('show')) closeEditSheet();
            else if (dayBackdrop.classList.contains('show')) closeDaySheet();
        });

        // Zen: button toggles the overlay; auto-pop happens on solo starts.
        document.getElementById('zenBtn').addEventListener('click', toggleZen);
        const zenOverlay = document.getElementById('zenOverlay');
        document.getElementById('zenExit').addEventListener('click', exitZen);
        zenOverlay.addEventListener('click', (e) => { if (e.target === zenOverlay) exitZen(); });

        // Reset the day — modal + hold-to-confirm
        const resetModal = document.getElementById('resetModal');
        const confirmBtn = document.getElementById('modalConfirm');
        document.getElementById('resetBtn').addEventListener('click', openResetModal);
        document.getElementById('modalCancel').addEventListener('click', closeResetModal);
        resetModal.addEventListener('click', (e) => { if (e.target === resetModal) closeResetModal(); });

        // Pointer: press and hold to confirm.
        confirmBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); ensureAudio(); beginHold(); });
        confirmBtn.addEventListener('pointerup', cancelHold);
        confirmBtn.addEventListener('pointerleave', cancelHold);
        confirmBtn.addEventListener('pointercancel', cancelHold);

        // Keyboard: hold Enter/Space to confirm; Esc cancels.
        confirmBtn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); beginHold(); }
        });
        confirmBtn.addEventListener('keyup', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cancelHold(); }
        });
        confirmBtn.addEventListener('blur', cancelHold);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && resetModal.classList.contains('show')) closeResetModal();
            else if (e.key === 'Escape' && zenOverlay.classList.contains('show')) exitZen();
        });

        // Done slider modal (percent categories): plain click confirm, slider for used time.
        const doneModal = document.getElementById('doneModal');
        const doneSlider = document.getElementById('doneSlider');
        document.getElementById('doneConfirm').addEventListener('click', confirmDone);
        document.getElementById('doneCancel').addEventListener('click', closeDoneModal);
        doneModal.addEventListener('click', (e) => { if (e.target === doneModal) closeDoneModal(); });
        doneSlider.addEventListener('input', updateDoneVal);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && doneModal.classList.contains('show')) closeDoneModal();
        });

        // Keyboard: spacebar toggles whichever row is focused's timer; Ctrl/Cmd+Z undoes a remove.
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                if (undoState) { e.preventDefault(); doUndo(); }
                return;
            }
            if (e.key === ' ' && document.activeElement && document.activeElement.closest('.category-row')) {
                const row = document.activeElement.closest('.category-row');
                // Only treat as timer toggle if the focused element is the button itself,
                // so space doesn't hijack typing in inputs.
                if (document.activeElement.classList.contains('btn-timer')) {
                    e.preventDefault();
                    const id = row.dataset.id;
                    const listKey = row.closest('#percentContainer') ? 'percent' : 'fixed';
                    toggleBlock(listKey, id);
                }
            }
        });

        // Resume audio on first interaction (mobile autoplay-safe).
        document.addEventListener('pointerdown', ensureAudio, { once: true });

        renderStructure();
        setInterval(updateLive, 500);
        // Refresh immediately when returning to the tab (timers are timestamp-based, so this just re-renders).
        document.addEventListener('visibilitychange', () => { if (!document.hidden) updateLive(); });
    }

    // Make sure existing blocks have a color from the palette (for very old saves).
    function reassignColorsIfNeeded() {
        let i = 0;
        [...state.fixed, ...state.percent].forEach(b => {
            if (!b.color) b.color = PALETTE[i % PALETTE.length];
            i++;
        });
        colorIdx = i;
    }

    init();
