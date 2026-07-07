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

    /* ── Preset color sets. Each row gets its own color from the active set, by index.
       The palette button cycles the active set. ── */
    const PALETTE_SETS = [
        { name: "Neon",   colors: ['#ef476f', '#11f1f7', '#bc8efc', '#fb8500', '#8338ec', '#f72585', '#3a0ca3'] },
        { name: "Warm",   colors: ['#ff8c42', '#ffd166', '#f72585', '#ef476f', '#e63946', '#fb8500', '#e76f51'] },
        { name: "Cool",   colors: ['#3a86ff', '#06d6a0', '#11f1f7', '#8338ec', '#bc8efc', '#4361ee', '#7209b7'] },
        { name: "Earth",  colors: ['#a3b18a', '#e9c46a', '#bc6c25', '#ddbea9', '#588157', '#cb997e', '#b08968'] },
        { name: "Candy",  colors: ['#ff6b9d', '#feca57', '#48dbfb', '#1dd1a1', '#ff9ff3', '#54a0ff', '#5f27cd'] },
        { name: "Mono",   colors: ['#e9ecef', '#ced4da', '#adb5bd', '#868e96', '#6c757d', '#495057', '#dee2e6'] },
    ];
    function currentPalette() { return PALETTE_SETS[state.paletteIdx].colors; }
    let colorIdx = 0;
    function pickColor() { const pal = currentPalette(); return pal[colorIdx++ % pal.length]; }

    function uid() { return Math.random().toString(36).slice(2, 10); }
    function nowMs() { return Date.now(); }

    // --- State ---
    // Each block: { id, name, hours|percent, banked(seconds), startedAt(ms|null), color, alarmed }
    let state = {
        wake: DEFAULT_WAKE,
        bed: DEFAULT_BED,
        multitask: false,
        mode: 'edit',
        paletteIdx: 0,
        nowMode: false,    // "Start from NOW" reflow active?
        nowBaseline: {},   // id → elapsedOf(b) snapshot (seconds) at the moment nowMode engaged
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
                    mode: (s.mode === 'run') ? 'run' : 'edit',
                    paletteIdx: Math.max(0, Math.min(PALETTE_SETS.length - 1, s.paletteIdx|0)),
                    nowMode: !!s.nowMode,
                    nowBaseline: (s.nowBaseline && typeof s.nowBaseline === 'object') ? s.nowBaseline : {},
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
            done: !!b.done,       // fixed blocks only: marked finished → release leftover to percent splits
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
    function budgetSecPercent(b, remainingHours) { return remainingHours * (b.percent || 0) / 100 * 3600; }

    /* ── "Start from NOW" net resplit.
       The day's plan gives each block a dayTarget (its plan budget). Time already
       spent counts against it: weight = max(0, dayTarget − spent). The wall-clock
       time left until bed is then handed out in proportion to those weights, so
       over-spent budgets drop out (weight 0) and the future always fills now→bed
       exactly. Returns { allocs: id→futureSec, remainingSec, totalSpentSec, dropped: [names] }. ── */
    function dayTargetSec(b, remainingHours) {
        const isPercent = state.percent.includes(b);
        return isPercent ? budgetSecPercent(b, remainingHours) : budgetSecFixed(b);
    }
    function computeNowAllocations(remainingHours) {
        const { bed } = dayBoundsMin();
        const remainingSec = Math.max(0, (bed - nowMin()) * 60);   // wall-clock now → bed
        const all = [...state.fixed, ...state.percent];
        const weights = {};
        let W = 0;
        all.forEach(b => {
            const w = Math.max(0, dayTargetSec(b, remainingHours) - elapsedOf(b));
            weights[b.id] = w;
            W += w;
        });
        const allocs = {};
        const dropped = [];
        all.forEach(b => {
            allocs[b.id] = W > 0 ? remainingSec * weights[b.id] / W : 0;
            if (weights[b.id] <= 0 && elapsedOf(b) > 0) dropped.push(b.name);
        });
        const totalSpentSec = all.reduce((s, b) => s + elapsedOf(b), 0);
        return { allocs, remainingSec, totalSpentSec, dropped };
    }

    /* Shared budget/elapsed pair for a row, zen card, results row, and segment.
       NOW mode swaps in the resplit slice and counts only time spent since NOW
       was engaged; otherwise the plan target and full elapsed. */
    function rowBudget(b, isPercent, remainingHours) {
        if (state.nowMode && liveAllocs) {
            const budget = liveAllocs.allocs[b.id] || 0;
            const baseline = state.nowBaseline[b.id] || 0;
            return { budget, secAgainst: Math.max(0, elapsedOf(b) - baseline) };
        }
        return {
            budget: isPercent ? budgetSecPercent(b, remainingHours) : budgetSecFixed(b),
            secAgainst: elapsedOf(b),
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
        save(); renderStructure(); focusName(b.id);
    }
    function addPercent() {
        const b = { id: uid(), name: 'New Cat', percent: 0, banked: 0, startedAt: null, color: pickColor(), alarmed: false, intervals: [] };
        state.percent.push(b);
        save(); renderStructure(); focusName(b.id);
    }
    function removeBlock(listKey, id) {
        const list = state[listKey];
        const idx = list.findIndex(x => x.id === id);
        if (idx < 0) return;
        const block = list[idx];
        stopBlock(block);            // bank whatever was running so undo preserves it
        list.splice(idx, 1);
        delete state.nowBaseline[block.id];
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
    function focusName(id) {
        const row = document.querySelector(`[data-id="${id}"]`);
        if (row && state.mode === 'edit') { const inp = row.querySelector('input[type="text"]'); if (inp) inp.focus(); }
    }

    // --- Toast (shared by undo / alarm / palette) ---
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

        // Fixed blocks only: a DONE toggle that releases leftover planned time to the
        // percent splits. stopPropagation so tapping it in run mode doesn't also toggle
        // the timer via the row handler.
        let doneBtn = null;
        if (!isPercent) {
            doneBtn = document.createElement('button');
            doneBtn.className = 'btn-done';
            doneBtn.title = 'Mark done — release any leftover time to your other categories (tap again to undo)';
            doneBtn.addEventListener('click', (e) => { e.stopPropagation(); ensureAudio(); toggleDone(b); });
        }

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

        // Run mode: tap the whole row to start/stop. (Edit mode uses the button.)
        row.addEventListener('click', (e) => {
            if (state.mode !== 'run') return;
            toggleBlock(listKey, b.id);
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
                tlSegs.appendChild(seg);
                segEls[b.id] = seg;
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

        // NOW mode → resplit slice + time-since-NOW; else plan target + full elapsed.
        const { budget, secAgainst } = rowBudget(b, isPercent, remainingHours);

        // Big display: elapsed in edit mode, remaining in run mode
        const shown = runMode ? Math.max(0, budget - secAgainst) : sec;
        e.timerElapsed.textContent = formatDigitalTime(shown);
        const done = !!b.done;
        e.timerBudget.textContent = runMode
            ? (running ? 'left' : (done ? 'done' : ''))
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

        // Stripes overlay the bar's solid color; density grows with spent/budget so
        // you can read how much of a block has been used straight off the bar.
        const stripe = (seg, budgetSec, secAgainst) => {
            const r = budgetSec > 0 ? Math.min(1, secAgainst / budgetSec) : (secAgainst > 0 ? 1 : 0);
            if (r <= 0) { seg.style.backgroundImage = 'none'; return; }
            const period = Math.max(4, 40 * (1 - r) + 4);   // sparse (40px) → dense (4px) as it fills
            const a = (0.22 * r).toFixed(2);
            const half = (period / 2).toFixed(1);
            seg.style.backgroundImage =
                `repeating-linear-gradient(45deg, rgba(0,0,0,${a}) 0, rgba(0,0,0,${a}) ${half}px, transparent ${half}px, transparent ${period.toFixed(1)}px)`;
        };

        const placeSeg = (b, leftPct, widthPct, budgetSec, secAgainst) => {
            const seg = segEls[b.id];
            if (!seg) return;
            const w = Math.max(0, widthPct);
            seg.style.left = leftPct + '%';
            seg.style.width = w + '%';
            seg.style.backgroundColor = b.color;
            seg.classList.toggle('done', !!b.done);
            seg.style.borderBottom = '2px solid ' + displayColor(b, budgetSec, secAgainst);
            stripe(seg, budgetSec, secAgainst);
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
            // NOW mode: net-resplit slices of now→bed, fixed then percent.
            [...state.fixed, ...state.percent].forEach(b => {
                const isPercent = state.percent.includes(b);
                const { budget, secAgainst } = rowBudget(b, isPercent, remaining);
                const w = dayLenSec > 0 ? budget / dayLenSec * 100 : 0;
                placeSeg(b, cursor, w, budget, secAgainst);
                const seg = segEls[b.id];
                if (seg) seg.title = b.name + ' · NOW resplit ' + formatHumanTime(budget) + ' · ' + formatHumanTime(secAgainst) + ' spent since NOW';
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

        // NOW line + dim past track (past track shown only in NOW mode).
        const nowLine = document.getElementById('tlNow');
        if (nowLine) {
            nowLine.style.left = npct + '%';
            const lbl = document.getElementById('tlNowLabel');
            if (lbl) lbl.textContent = 'NOW ' + formatClock(nowMin());
        }
        const tlPast = document.getElementById('tlPast');
        if (tlPast) tlPast.style.width = (state.nowMode ? npct : 0) + '%';

        renderBlobs(npct);

        // Caption: NOW summary in NOW mode, plan summary otherwise.
        const caption = document.getElementById('vizCaption');
        if (state.nowMode && liveAllocs) {
            const parts = [formatHumanTime(liveAllocs.remainingSec) + ' left until bed',
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
            item.querySelector('span:first-child').textContent = `${b.name} (${b.percent}%)`;
            item.querySelector('.budget-val').textContent = `Budget ${formatHumanTime(budget)}`;
            const tv = item.querySelector('.time-val');
            tv.textContent = `Actual ${formatHumanTime(secAgainst)}`;
            tv.style.color = ratioColor(b.color, budget, secAgainst);
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
        state.nowMode = false;
        state.nowBaseline = {};
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

    // --- Palette cycler: reassign every block's color from the active set, by index ---
    function reassignColors() {
        const pal = currentPalette();
        let i = 0;
        [...state.fixed, ...state.percent].forEach(b => { b.color = pal[i % pal.length]; i++; });
        colorIdx = i;   // next new block continues the rotation
    }
    function applyPaletteLabel() {
        document.getElementById('paletteBtn').textContent = PALETTE_SETS[state.paletteIdx].name;
    }
    function cyclePalette() {
        state.paletteIdx = (state.paletteIdx + 1) % PALETTE_SETS.length;
        reassignColors();
        applyPaletteLabel();
        save(); renderStructure();
        showToast('Palette: ' + PALETTE_SETS[state.paletteIdx].name, false);
        clearTimeout(toastTimer);
        toastTimer = setTimeout(hideToast, 1600);
    }

    // --- Run / Edit mode ---
    function applyMode() {
        document.getElementById('app').classList.toggle('mode-run', state.mode === 'run');
        const modeBtn = document.getElementById('modeBtn');
        modeBtn.textContent = state.mode === 'run' ? 'Edit' : 'Run';
        modeBtn.setAttribute('aria-label', state.mode === 'run' ? 'Switch to edit mode' : 'Switch to run mode');
        // Name inputs become read-only in run mode (tapping the row toggles instead).
        document.querySelectorAll('.category-row input[type="text"]').forEach(n => n.readOnly = (state.mode === 'run'));
    }
    function toggleMode() {
        state.mode = state.mode === 'run' ? 'edit' : 'run';
        if (state.mode === 'run' && document.activeElement && document.activeElement.blur) document.activeElement.blur();
        save(); applyMode(); renderStructure();
    }

    // --- Start from NOW: reflow the remainder (now → bed) across budgets ---
    // Engaging snapshots each block's elapsed so the "left" countdowns only count
    // time spent *after* this moment. Disengaging returns to the full-day plan.
    function applyNowLabel() {
        const btn = document.getElementById('nowBtn');
        if (!btn) return;
        btn.textContent = state.nowMode ? 'Plan' : 'Start from NOW';
        btn.setAttribute('aria-pressed', state.nowMode ? 'true' : 'false');
        btn.classList.toggle('active', state.nowMode);
    }
    function applyDayLabel() {
        const el = document.getElementById('dayLength');
        if (el) el.textContent = formatHumanTime(dayLengthHours() * 3600) + ' to spend';
    }
    function toggleNow() {
        state.nowMode = !state.nowMode;
        if (state.nowMode) {
            // Snapshot elapsed per block — the baseline "now" counts against from here.
            [...state.fixed, ...state.percent].forEach(b => {
                state.nowBaseline[b.id] = elapsedOf(b);
                b.alarmed = false;   // re-arm alarms against the new resplit budgets
            });
        } else {
            state.nowBaseline = {};
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

    // --- Init ---
    function init() {
        const had = load();
        if (!had) seedDefaults();
        // If loaded an old save with no palette assignment for current set, ensure colors exist.
        if (had) reassignColorsIfNeeded();
        applyPaletteLabel();
        applyMode();
        applyNowLabel();
        applyDayLabel();

        // Wake / bed define the day (and thus the bank). Either changing reflows
        // the timeline + ticks and recomputes the resplit.
        const wakeInput = document.getElementById('wakeInput');
        const bedInput = document.getElementById('bedInput');
        wakeInput.value = state.wake;
        bedInput.value = state.bed;
        const onDayChange = () => {
            state.wake = wakeInput.value || DEFAULT_WAKE;
            state.bed = bedInput.value || DEFAULT_BED;
            save();
            applyDayLabel();
            renderTicks(document.getElementById('tlTicks'));
            updateLive();
        };
        wakeInput.addEventListener('input', onDayChange);
        bedInput.addEventListener('input', onDayChange);

        document.getElementById('nowBtn').addEventListener('click', () => { ensureAudio(); toggleNow(); });

        const mt = document.getElementById('multitask');
        mt.checked = state.multitask;
        mt.addEventListener('change', () => {
            state.multitask = mt.checked;
            updateZenVisibility();
            save();
        });

        document.getElementById('addFixedBtn').addEventListener('click', addFixed);
        document.getElementById('addPercentBtn').addEventListener('click', addPercent);
        document.getElementById('toastUndo').addEventListener('click', doUndo);
        document.getElementById('paletteBtn').addEventListener('click', cyclePalette);
        document.getElementById('modeBtn').addEventListener('click', toggleMode);

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

    // Make sure existing blocks have a color from the active palette (for very old saves).
    function reassignColorsIfNeeded() {
        const pal = currentPalette();
        let i = 0;
        [...state.fixed, ...state.percent].forEach(b => {
            if (!b.color) b.color = pal[i % pal.length];
            i++;
        });
        colorIdx = i;
    }

    init();
