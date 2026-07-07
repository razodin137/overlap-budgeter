"use strict";

    const STORAGE_KEY = "overlapBudgeter.v1";

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
        totalBank: 24,
        multitask: false,
        mode: 'edit',
        paletteIdx: 0,
        zenMode: 'auto',   // 'auto' (solo auto-open) | 'on' (always) | 'off' (never)
        fixed: [],
        percent: [],
    };

    let undoState = null;
    let undoTimer = null;
    let toastTimer = null;

    // Stable element refs so we never rebuild inputs mid-typing.
    const rowEls = {};   // id -> { row, timer, timerElapsed, timerBudget, btn, progress, progressFill }
    const segEls = {};   // id -> segment div
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
                    totalBank: typeof s.totalBank === 'number' ? s.totalBank : 24,
                    multitask: !!s.multitask,
                    mode: (s.mode === 'run') ? 'run' : 'edit',
                    paletteIdx: Math.max(0, Math.min(PALETTE_SETS.length - 1, s.paletteIdx|0)),
                    zenMode: (s.zenMode === 'on' || s.zenMode === 'off') ? s.zenMode : 'auto',
                    fixed: Array.isArray(s.fixed) ? s.fixed.map(norm) : [],
                    percent: Array.isArray(s.percent) ? s.percent.map(norm) : [],
                };
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
            banked: b.banked || 0,
            startedAt: b.startedAt || null,
            color: b.color || pickColor(),
            alarmed: !!b.alarmed,
        };
    }

    function seedDefaults() {
        state.fixed = [
            { id: uid(), name: 'Lunch', hours: 1, banked: 0, startedAt: null, color: pickColor(), alarmed: false },
            { id: uid(), name: 'Dinner', hours: 1, banked: 0, startedAt: null, color: pickColor(), alarmed: false },
        ];
        state.percent = [
            { id: uid(), name: 'Bills', percent: 50, banked: 0, startedAt: null, color: pickColor(), alarmed: false },
            { id: uid(), name: 'Fun', percent: 10, banked: 0, startedAt: null, color: pickColor(), alarmed: false },
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
        // A fresh start re-opens zen (auto mode shows it for solo timers).
        zenDismissed = false;
    }
    function stopBlock(b) {
        if (!b.startedAt) return;
        b.banked += Math.floor((nowMs() - b.startedAt) / 1000);
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
    function budgetSecFixed(b) { return (b.hours || 0) * 3600; }
    function budgetSecPercent(b, remainingHours) { return remainingHours * (b.percent || 0) / 100 * 3600; }

    // Color carries state: on-track = base, approaching budget = amber, over = red.
    function ratioColor(base, budgetSec, actualSec) {
        if (budgetSec <= 0) return actualSec > 0 ? '#ff4d4d' : base;
        const r = actualSec / budgetSec;
        if (r >= 1) return '#ff4d4d';
        if (r >= 0.85) return '#ffd166';
        return base;
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
        const b = { id: uid(), name: 'New Block', hours: 1, banked: 0, startedAt: null, color: pickColor(), alarmed: false };
        state.fixed.push(b);
        save(); renderStructure(); focusName(b.id);
    }
    function addPercent() {
        const b = { id: uid(), name: 'New Cat', percent: 0, banked: 0, startedAt: null, color: pickColor(), alarmed: false };
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

        const rm = document.createElement('button');
        rm.className = 'btn-remove'; rm.textContent = '×';
        rm.addEventListener('click', () => removeBlock(listKey, b.id));

        // Per-row progress bar (fill = block color, grows with elapsed/budget)
        const progress = document.createElement('div');
        progress.className = 'progress';
        const fill = document.createElement('div');
        fill.className = 'progress-fill';
        progress.appendChild(fill);

        row.append(name, num, disp, btn, rm, progress);

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
        const viz = document.getElementById('visualizer');
        fC.innerHTML = ''; pC.innerHTML = ''; viz.innerHTML = '';
        for (const k in rowEls) delete rowEls[k];
        for (const k in segEls) delete segEls[k];

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
                    progress: row.querySelector('.progress'),
                    progressFill: row.querySelector('.progress-fill'),
                };
                const seg = document.createElement('div');
                seg.className = 'segment';
                viz.appendChild(seg);
                segEls[b.id] = seg;
            });
        };
        attach(fC, 'fixed', false);
        attach(pC, 'percent', true);

        freeSeg = document.createElement('div');
        freeSeg.className = 'segment free';
        freeSeg.style.borderBottom = '2px solid transparent';
        viz.appendChild(freeSeg);

        updateLive();
    }

    function updateRow(b, isPercent, remainingHours) {
        const e = rowEls[b.id];
        if (!e) return;
        const sec = elapsedOf(b);
        const running = !!b.startedAt;
        const budget = isPercent ? budgetSecPercent(b, remainingHours) : budgetSecFixed(b);
        const runMode = state.mode === 'run';

        // Big display: elapsed in edit mode, remaining in run mode
        const shown = runMode ? Math.max(0, budget - sec) : sec;
        e.timerElapsed.textContent = formatDigitalTime(shown);
        e.timerBudget.textContent = runMode ? (running ? 'left' : '') : 'of ' + formatCompact(budget);
        e.timerElapsed.style.color = ratioColor(b.color, budget, sec);
        e.row.classList.toggle('active', running);
        e.row.classList.toggle('alarm', !!b.alarmed);
        // Running row lights up in its own identity color; idle falls back to the section rail.
        e.row.style.borderLeftColor = running ? b.color : '';
        e.row.style.borderLeftStyle = running ? 'solid' : '';
        e.btn.classList.toggle('running', running);
        e.btn.textContent = running ? 'Stop' : 'Start';

        // Progress bar: fill IS the block color and grows with elapsed/budget.
        // Track is a faded tint of the same color; fill turns amber near, red over.
        const pct = budget > 0 ? Math.min(100, (sec / budget) * 100) : (sec > 0 ? 100 : 0);
        e.progressFill.style.width = pct + '%';
        e.progressFill.style.backgroundColor = ratioColor(b.color, budget, sec);
        e.progress.style.background = fade(b.color);

        // Alarm: crossed budget while running, fires once.
        if (running && budget > 0 && sec >= budget && !b.alarmed) {
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
        const bank = parseFloat(document.getElementById('totalBank').value) || 0;
        const totalFixed = state.fixed.reduce((s, b) => s + (b.hours || 0), 0);
        const remaining = Math.max(0, bank - totalFixed);
        document.getElementById('remainingCaption').textContent =
            remaining > 0 ? 'splitting ' + formatHumanTime(remaining * 3600) + ' after fixed blocks'
                          : 'no time left after fixed blocks';
        let totalPercent = 0;
        state.percent.forEach(b => totalPercent += (b.percent || 0));

        // Fixed segments: identity fill, status as a 2px baseline (transparent / amber / red).
        state.fixed.forEach(b => {
            const seg = segEls[b.id]; if (!seg) return;
            const w = bank > 0 ? (b.hours / bank) * 100 : 0;
            seg.style.width = w + '%';
            const bsec = budgetSecFixed(b);
            seg.style.backgroundColor = b.color;
            seg.style.borderBottom = '2px solid ' + ratioColor('transparent', bsec, elapsedOf(b));
            seg.title = b.name + ': ' + formatHumanTime(bsec) + ' budget · ' + formatHumanTime(elapsedOf(b)) + ' actual';
        });

        // Percent segments: identity fill, status baseline; tooltip names the hour equivalent.
        state.percent.forEach(b => {
            const seg = segEls[b.id]; if (!seg) return;
            const w = bank > 0 ? (b.percent / 100) * (remaining / bank) * 100 : 0;
            seg.style.width = w + '%';
            const bsec = budgetSecPercent(b, remaining);
            seg.style.backgroundColor = b.color;
            seg.style.borderBottom = '2px solid ' + ratioColor('transparent', bsec, elapsedOf(b));
            seg.title = b.name + ' (' + b.percent + '% = ' + formatHumanTime(bsec) + ' of remaining) · ' + formatHumanTime(elapsedOf(b)) + ' actual';
        });

        // Free / unallocated slack
        const freeHours = remaining - remaining * (Math.min(totalPercent, 100) / 100);
        freeSeg.style.width = (bank > 0 ? Math.max(0, freeHours / bank) * 100 : 0) + '%';
        freeSeg.title = 'Free of remaining / unallocated: ' + formatHumanTime(freeHours * 3600);
        document.getElementById('vizCaption').textContent =
            formatHumanTime(remaining * 3600) + ' left to split  ·  ' + formatHumanTime(freeHours * 3600) + ' free';

        document.getElementById('warning').style.display = totalPercent > 100 ? 'block' : 'none';
        buildResults(bank, remaining, totalPercent);
        return { bank, remaining, totalPercent };
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
            const budget = budgetSecFixed(b);
            const sec = elapsedOf(b);
            item.querySelector('span:first-child').textContent = `${b.name} (Fixed)`;
            item.querySelector('.budget-val').textContent = `Budget ${formatHumanTime(budget)}`;
            const tv = item.querySelector('.time-val');
            tv.textContent = `Actual ${formatHumanTime(sec)}`;
            tv.style.color = ratioColor(b.color, budget, sec);
        });
        state.percent.forEach(b => {
            const item = list.querySelector(`.result-item[data-id="${b.id}"]`);
            if (!item) return;
            const budget = budgetSecPercent(b, remaining);
            const sec = elapsedOf(b);
            item.querySelector('span:first-child').textContent = `${b.name} (${b.percent}%)`;
            item.querySelector('.budget-val').textContent = `Budget ${formatHumanTime(budget)}`;
            const tv = item.querySelector('.time-val');
            tv.textContent = `Actual ${formatHumanTime(sec)}`;
            tv.style.color = ratioColor(b.color, budget, sec);
        });
        const freeRow = list.querySelector('.free-row');
        const freeH = Math.max(0, remaining - remaining * Math.min(totalPercent, 100) / 100);
        if (freeRow) {
            freeRow.style.display = freeH > 0 ? '' : 'none';
            freeRow.querySelector('.time-val').textContent = formatHumanTime(freeH * 3600);
        }
    }

    function updateLive() {
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
        });
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

    // --- Zen mode: full-screen focus on whatever is running ---
    // Visibility policy:
    //   auto: show whenever a solo timer runs (multitask off); dismiss until next start.
    //   on:   always visible; exiting drops back to auto.
    //   off:  never visible.
    // Exiting never stops timers — they keep running and zen can be reactivated.
    const ZEN_MODES = ['auto', 'on', 'off'];
    let zenDismissed = false;     // user paged out of an auto zen; cleared on next start
    let zenSig = '';              // set of running ids currently rendered (avoids per-tick churn)

    function remainingHours() {
        const bank = parseFloat(document.getElementById('totalBank').value) || 0;
        const totalFixed = state.fixed.reduce((s, b) => s + (b.hours || 0), 0);
        return Math.max(0, bank - totalFixed);
    }
    function runningBlocks() {
        return [...state.fixed, ...state.percent].filter(b => b.startedAt);
    }
    function zenShouldShow() {
        if (state.zenMode === 'off') return false;
        if (state.zenMode === 'on') return true;
        // auto: solo only — never auto-open while overlapping timers are allowed
        if (state.multitask) return false;
        return runningBlocks().length > 0 && !zenDismissed;
    }
    function applyZenLabel() {
        const btn = document.getElementById('zenBtn');
        btn.textContent = state.zenMode.charAt(0).toUpperCase() + state.zenMode.slice(1);
    }
    function updateZenVisibility() {
        const overlay = document.getElementById('zenOverlay');
        const show = zenShouldShow();
        overlay.classList.toggle('show', show);
        overlay.setAttribute('aria-hidden', show ? 'false' : 'true');
        document.getElementById('zenBtn').classList.toggle('active', show);
        if (show) updateZen();
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
            const budget = isPercent ? budgetSecPercent(b, remaining) : budgetSecFixed(b);
            const sec = elapsedOf(b);
            const card = content.querySelector(`.zen-card[data-id="${b.id}"]`);
            if (!card) return;
            const shown = runMode ? Math.max(0, budget - sec) : sec;
            card.querySelector('.zen-name').textContent = b.name;
            const time = card.querySelector('.zen-time');
            time.textContent = formatDigitalTime(shown);
            time.style.color = ratioColor(b.color, budget, sec);
            card.querySelector('.zen-sub').textContent = runMode ? (b.startedAt ? 'left' : '') : 'of ' + formatCompact(budget);
            const pct = budget > 0 ? Math.min(100, (sec / budget) * 100) : (sec > 0 ? 100 : 0);
            const fill = card.querySelector('.zen-progress-fill');
            fill.style.width = pct + '%';
            fill.style.backgroundColor = ratioColor(b.color, budget, sec);
            card.querySelector('.zen-progress').style.background = fade(b.color);
            card.classList.toggle('alarm', !!b.alarmed);
        });
    }
    function cycleZen() {
        state.zenMode = ZEN_MODES[(ZEN_MODES.indexOf(state.zenMode) + 1) % ZEN_MODES.length];
        zenDismissed = false;          // pressing the button reactivates zen with whatever is running
        applyZenLabel();
        updateZenVisibility();
        save();
    }
    // Page out of zen. Timers keep running; re-enter via the button or a fresh solo start.
    function exitZen() {
        if (state.zenMode === 'on') state.zenMode = 'auto';   // forced → auto
        zenDismissed = true;
        applyZenLabel();
        updateZenVisibility();
        save();
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
        applyZenLabel();

        const bankInput = document.getElementById('totalBank');
        bankInput.value = state.totalBank;
        bankInput.addEventListener('input', () => {
            state.totalBank = parseFloat(bankInput.value) || 0;
            save(); updateLive();
        });

        const mt = document.getElementById('multitask');
        mt.checked = state.multitask;
        mt.addEventListener('change', () => {
            state.multitask = mt.checked;
            if (!state.multitask) zenDismissed = false;   // back to solo: let zen reopen
            updateZenVisibility();
            save();
        });

        document.getElementById('addFixedBtn').addEventListener('click', addFixed);
        document.getElementById('addPercentBtn').addEventListener('click', addPercent);
        document.getElementById('toastUndo').addEventListener('click', doUndo);
        document.getElementById('paletteBtn').addEventListener('click', cyclePalette);
        document.getElementById('modeBtn').addEventListener('click', toggleMode);

        // Zen mode: cycle Auto / On / Off; paging out keeps timers running.
        document.getElementById('zenBtn').addEventListener('click', cycleZen);
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
