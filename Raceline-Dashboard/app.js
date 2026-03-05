// Slip Angle & Raceline Control Dashboard - app.js
// Usage: open index.html in a browser. This single-file app runs offline.

(function(){
  // Utilities
  const qs = s=>document.querySelector(s);
  const qsa = s=>Array.from(document.querySelectorAll(s));

  // State
  const state = {raw: null, data: null, columns: [], mapping:{}, settings:{devThresh:0.4,slipThresh:6, showCorners:false}, metrics:{}, files: [], startLineMode:false, startRefIdx:null, lapNumbers:null, lapCount:0, showAllLaps:true, lapParams: { minLapTime: 6.0, forwardSpeedThreshold: 0.2 }}

  // Init UI
  function init(){
    // tabs
    qsa('#sidebar nav button').forEach(btn=>btn.addEventListener('click',()=>{qsa('#sidebar nav button').forEach(b=>b.classList.remove('active'));btn.classList.add('active');switchTab(btn.dataset.tab)}));
    // uploader
    const drop = qs('#dropzone');
    drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('hover')});
    drop.addEventListener('dragleave',e=>{drop.classList.remove('hover')});
    drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('hover');handleFiles(e.dataTransfer.files)});
    qs('#fileInput').addEventListener('change',e=>handleFiles(e.target.files));
    qs('#exportJson').addEventListener('click',exportJSON);
    qs('#exportPng').addEventListener('click',exportPNG);
    const diagBtn = qs('#diagBtn'); if(diagBtn) diagBtn.addEventListener('click', showDiagnostics);
    const applyBtn = qs('#applyMapBtn'); if(applyBtn) applyBtn.addEventListener('click', applyRecommendedMappings);
    // (banner controls removed)
    // raceline lap controls
    const setStartBtn = qs('#setStartBtn'); if(setStartBtn) setStartBtn.addEventListener('click', ()=>{ state.startLineMode = true; setStartBtn.textContent = 'Click map to set start'; });
    const lapSelect = qs('#lapSelect'); if(lapSelect) lapSelect.addEventListener('change', e=>{ try{ preserveHoverForSelection(); }catch(e){} renderMap(); });
    const showAllCb = qs('#showAllLaps'); if(showAllCb) showAllCb.addEventListener('change', e=>{ state.showAllLaps = !!showAllCb.checked; renderMap(); });
    const showRefCb = qs('#showRef'); if(showRefCb) showRefCb.addEventListener('change', e=>{ renderMap(); });
    // attach lap tuning inputs wherever they exist in the DOM (mapControls or lapInfo)
    const minEl = qs('#minLapTimeInput'); if(minEl){ minEl.value = state.lapParams.minLapTime; minEl.addEventListener('change', e=>{ state.lapParams.minLapTime = parseFloat(minEl.value) || state.lapParams.minLapTime; renderMap(); }); }
    const fsp = qs('#forwardSpeedInput'); if(fsp){ fsp.value = state.lapParams.forwardSpeedThreshold; fsp.addEventListener('change', e=>{ state.lapParams.forwardSpeedThreshold = parseFloat(fsp.value) || state.lapParams.forwardSpeedThreshold; renderMap(); }); }
    const recomputeBtn = qs('#recomputeLapsBtn'); if(recomputeBtn){ recomputeBtn.addEventListener('click', e=>{ state.lapParams.minLapTime = parseFloat(minEl.value) || state.lapParams.minLapTime; state.lapParams.forwardSpeedThreshold = parseFloat(fsp.value) || state.lapParams.forwardSpeedThreshold; computeLapsFromStart(); renderMap(); renderLapList(); }); }
    // lap detection tuning controls (injected near lapInfo)
    const lapInfo = qs('#lapInfo'); if(lapInfo){
      // If the static inputs already exist in HTML (added in index.html), don't append duplicates.
      if(!qs('#minLapTimeInput')){
        const ctrl = document.createElement('div'); ctrl.style.marginTop = '6px'; ctrl.style.fontSize='12px'; ctrl.style.color='var(--muted)';
        ctrl.innerHTML = `Lap params: minLapTime <input id="minLapTimeInput" type="number" step="0.1" value="${state.lapParams.minLapTime}" style="width:70px"> s &nbsp; forwardSpeed <input id="forwardSpeedInput" type="number" step="0.05" value="${state.lapParams.forwardSpeedThreshold}" style="width:70px"> m/s &nbsp; <button id="recomputeLapsBtn">Recompute Laps</button>`;
        lapInfo.appendChild(ctrl);
      }
      // Attach listeners to the inputs (existing or newly created)
      setTimeout(()=>{
        const minEl = qs('#minLapTimeInput'); const fsp = qs('#forwardSpeedInput'); const btn = qs('#recomputeLapsBtn');
        if(minEl){ minEl.value = state.lapParams.minLapTime; minEl.addEventListener('change', e=>{ state.lapParams.minLapTime = parseFloat(minEl.value) || 1.0; }); }
        if(fsp){ fsp.value = state.lapParams.forwardSpeedThreshold; fsp.addEventListener('change', e=>{ state.lapParams.forwardSpeedThreshold = parseFloat(fsp.value) || 0.2; }); }
        if(btn) btn.addEventListener('click', e=>{ computeLapsFromStart(); renderMap(); renderLapList(); });
      },50);
    }
    qsa('input[name=mode]').forEach(r=>r.addEventListener('change',renderAll));
    qs('#devThresh').addEventListener('change',e=>{state.settings.devThresh=parseFloat(e.target.value);renderAll()});
    qs('#slipThresh').addEventListener('change',e=>{state.settings.slipThresh=parseFloat(e.target.value);renderAll()});
    // vehicle param inputs
    ['mass','wheelbase','lf','lr','Cf','Cr','Iz'].forEach(id=>{ const el = qs('#'+id); if(el) el.addEventListener('change', ()=>{ computeAll(); renderAll(); }); });

    // load sample
    loadSample();
    // (banner auto-load removed)
    // render recent uploads if any
    setTimeout(()=>{ try{ const wrap = qs('#recentUploads'); if(wrap && state.files && state.files.length){ wrap.innerHTML=''; for(const f of state.files.slice().reverse()){ const c = document.createElement('div'); c.className='recent-card'; c.innerHTML = `<div class="title">${f.name}</div><div class="meta">${(f.parsed && f.parsed.header? f.parsed.header.length+' cols':'')}</div><div><button class="btn-load">Load</button></div>`; const btn = c.querySelector('.btn-load'); btn.addEventListener('click', ()=>{ // re-enable this file and merge
          state.files.forEach(ff=> ff.enabled = false); f.enabled = true; mergeFilesAndProcess(); renderAll(); }); wrap.appendChild(c); } } }catch(e){} },200);
    // ensure any previous fullscreen state is cleared on startup
    document.body.classList.remove('map-fullscreen');
    removeMapCloseButton();
  }

  function findHeader(headers, patterns){
    const lower = headers.map(h=>h.toLowerCase());
    for(const p of patterns){
      for(let i=0;i<lower.length;i++){ if(lower[i].includes(p)) return headers[i]; }
    }
    return null;
  }

  function applyRecommendedMappings(){
    if(!state.files || state.files.length===0) return alert('No files loaded');
    // Auto-fix common mis-mappings before applying per-file heuristics
    for(const f of state.files){
      f.mapping = f.mapping || {};
      const lname = f.name.toLowerCase();
      // If vx was accidentally mapped to an IMU angular field, clear it
      if(f.mapping.vx && /angular|angular_velocity|gz|gy|gx/.test(String(f.mapping.vx).toLowerCase())){
        f.mapping.vx = null;
      }
      // IMU files: prefer angular_velocity_z for yaw_rate and linear_acceleration for ax/ay
      if(/imu/.test(lname)){
        f.mapping.yaw_rate = f.mapping.yaw_rate || findHeader(f.parsed.header, ['angular_velocity_z','angular_z','gz','yaw_rate']);
        f.mapping.ax = f.mapping.ax || findHeader(f.parsed.header, ['linear_acceleration_x','accel_x','ax','acceleration_x']);
        f.mapping.ay = f.mapping.ay || findHeader(f.parsed.header, ['linear_acceleration_y','accel_y','ay','acceleration_y']);
      }
      // velocity_body files: prefer linear_x for vx
      if(/velocity_body|vectornav/.test(lname) && /velocity_body/.test(lname)){
        const bestVx = findHeader(f.parsed.header, ['linear_x','vx','velocity_x','speed']); if(bestVx) f.mapping.vx = bestVx;
      }
      // steering files: avoid selecting counter fields; prefer steering_angle or steering_motor_fdbk
      if(/steer|steering/.test(lname)){
        // prefer explicit steering name headers and avoid counters; prefer commanded_steering_rate when present
        let alt = findHeader(f.parsed.header, ['commanded_steering_rate','steering_angle','steering_wheel_angle','steering','steering_motor_fdbk','steer','steering_angle_deg']);
        // if current mapping is a counter or missing, force an alternative
        const curSteer = (f.mapping && f.mapping.steer) ? String(f.mapping.steer).toLowerCase() : null;
        const isCounter = curSteer && /counter|cnt|index/.test(curSteer);
        if(alt && /counter/.test(String(alt).toLowerCase())){
          alt = null;
        }
        // if no clear header, pick a numeric column with variability (exclude monotonic counters)
        if(!alt){
          const hdrs = f.parsed.header;
          let best = null; let bestVar = 0;
          for(const h of hdrs){
            const valsRaw = f.parsed.rows.map(r=>{ const v = parseFloat(r[h]); return isFinite(v)? v : NaN; }).filter(v=>isFinite(v));
            if(valsRaw.length < 50) continue;
            const mean = valsRaw.reduce((s,v)=>s+v,0)/valsRaw.length;
            const variance = valsRaw.reduce((s,v)=>s+(v-mean)*(v-mean),0)/valsRaw.length;
            // skip likely counters: integer-like and monotonic
            const intLikeFrac = valsRaw.filter(v=>Math.abs(v-Math.round(v))<1e-6).length / valsRaw.length;
            const monotonic = valsRaw.slice(1).every((v,i)=> v >= valsRaw[i]);
            if(intLikeFrac > 0.9 && monotonic) continue;
            if(variance > bestVar){ bestVar = variance; best = h; }
          }
          if(best) alt = best;
        }
        // Force replace if previous mapping was a counter or missing
        if(isCounter || !f.mapping.steer){ if(alt) f.mapping.steer = alt; }
      }
      // After per-file heuristics, if this is a steering_report file and we still have a counter mapping, force commanded_steering_rate if present
      if(/steering_report\.csv|steering_report/i.test(lname)){
        const hdr = findHeader(f.parsed.header, ['commanded_steering_rate','steering_motor_fdbk','steering_angle','steering']);
        if(hdr && !/counter/.test(String(hdr).toLowerCase())) f.mapping.steer = hdr;
        else {
          // try to find commanded_steering_rate among all headers even if it wasn't matched earlier
          const cs = f.parsed.header.find(h=>String(h).toLowerCase().includes('commanded_steering_rate'));
          if(cs) f.mapping.steer = cs;
        }
      }
    }
    for(const f of state.files){
      const hdrs = f.parsed.header || [];
      const set = f.mapping || {};
      const lname = f.name.toLowerCase();
      // User-provided working preset: prefer these exact mappings when filenames match
      if(/bestgnsspos_top\.csv|bestgnsspos/i.test(lname)){
        set.time = findHeader(hdrs, ['stamp','time','time_status','sec','timestamp']) || set.time;
        set.lat = findHeader(hdrs, ['lat','latitude']) || set.lat;
        set.lon = findHeader(hdrs, ['lon','longitude','lng']) || set.lon;
        // clear other signals that may be present here
        set.heading = null; set.yaw_rate = null; set.vx = null; set.steer = null; set.ax = null; set.ay = null;
        f.mapping = set; continue;
      }
      if(/heading2_top\.csv|heading2/i.test(lname)){
        set.time = findHeader(hdrs, ['stamp','time','time_status','sec','timestamp']) || set.time;
        set.heading = findHeader(hdrs, ['heading','yaw','psi']) || set.heading;
        set.lat = null; set.lon = null; f.mapping = set; continue;
      }
      if(/imu_vectornav\.csv|imu_vectornav|imu/i.test(lname)){
        set.time = findHeader(hdrs, ['stamp','time','timestamp']) || set.time;
        set.ax = findHeader(hdrs, ['linear_acceleration_x','accel_x','acceleration_x','ax']) || set.ax;
        set.ay = findHeader(hdrs, ['linear_acceleration_y','accel_y','acceleration_y','ay']) || set.ay;
        set.lat = null; set.lon = null; set.heading = null; f.mapping = set; continue;
      }
      // ensure IMU yaw_rate mapping is captured
      if(/imu_vectornav\.csv|imu_vectornav|imu/i.test(lname)){
        set.yaw_rate = set.yaw_rate || findHeader(hdrs, ['angular_velocity_z_/vectornav/imu','angular_velocity_z','angular_z','gz','yaw_rate']);
        f.mapping = set; continue;
      }
      if(/velocity_body_vectornav\.csv|velocity_body_vectornav|velocity_body/i.test(lname)){
        set.time = findHeader(hdrs, ['stamp','time','timestamp']) || set.time;
        set.vx = findHeader(hdrs, ['linear_x','vx','velocity_x','speed']) || set.vx;
        // do not map lat/lon here
        set.lat = null; set.lon = null; f.mapping = set; continue;
      }
      if(/steering_report\.csv|steering_report/i.test(lname)){
        set.time = findHeader(hdrs, ['stamp','time','timestamp']) || set.time;
        set.steer = findHeader(hdrs, ['steering_angle','steering','steering_motor_fdbk_counter','steering_motor_fdbk']) || set.steer;
        f.mapping = set; continue;
      }
      if(/path\.csv|^path$/i.test(lname)){
        set.time = findHeader(hdrs, ['planner_computation_time','time','stamp']) || set.time;
        // Path uses current_state_y as latitude (lateral) and current_state_x as longitude (forward)
        set.lat = findHeader(hdrs, ['current_state_y','current_state_y']) || set.lat;
        set.lon = findHeader(hdrs, ['current_state_x','current_state_x']) || set.lon;
        set.vx = findHeader(hdrs, ['current_state_velocity_x','current_state_velocity_x','velocity_x']) || set.vx;
        f.mapping = set; continue;
      }
      // GNSS / bestgnsspos / gps
      if(/bestgnss|gps|gnss/.test(lname)){
        set.time = set.time || findHeader(hdrs, ['stamp','time_status','time','sec','timestamp']);
        set.lat = set.lat || findHeader(hdrs, ['lat','latitude']);
        set.lon = set.lon || findHeader(hdrs, ['lon','longitude','lng']);
      }
      // heading file
      else if(/heading/.test(lname)){
        set.time = set.time || findHeader(hdrs, ['stamp','time','time_status']);
        set.heading = set.heading || findHeader(hdrs, ['heading','yaw','psi']);
      }
      // imu
      else if(/imu|vectornav/.test(lname) && lname.includes('imu')){
        set.time = set.time || findHeader(hdrs, ['stamp','time','timestamp']);
        set.ax = set.ax || findHeader(hdrs, ['linear_acceleration_x','accel_x','ax','acceleration_x']);
        set.ay = set.ay || findHeader(hdrs, ['linear_acceleration_y','accel_y','ay','acceleration_y']);
        set.yaw_rate = set.yaw_rate || findHeader(hdrs, ['angular_velocity_z','angular_z','gz','yaw_rate']);
      }
      // velocity body
      else if(/velocity_body|vectornav/.test(lname) && lname.includes('velocity')){
        set.time = set.time || findHeader(hdrs, ['stamp','time','timestamp']);
        set.vx = set.vx || findHeader(hdrs, ['linear_x','vx','velocity_x','speed']);
        // optional lateral
        set.ay = set.ay || null;
        // map linear_y to a vy candidate in mapping.lat/lon if no pos
        if(!set.lat && findHeader(hdrs,['linear_y','vy','velocity_y'])){
          // leave lat/lon alone; vx/vy handled by vx mapping and available columns
        }
      }
      // steering
      else if(/steer|steering/.test(lname)){
        set.time = set.time || findHeader(hdrs, ['stamp','time','timestamp']);
        set.steer = set.steer || findHeader(hdrs, ['steering','steer','steering_angle','steering_motor_fdbk_counter']);
      }
      // path / raceline
      else if(/path/.test(lname)){
        set.time = set.time || findHeader(hdrs, ['planner_computation_time','time','stamp']);
        set.lat = set.lat || findHeader(hdrs, ['current_state_y','y','lat']);
        set.lon = set.lon || findHeader(hdrs, ['current_state_x','x','lon']);
        set.vx = set.vx || findHeader(hdrs, ['current_state_velocity_x','velocity_x','speed']);
      }
      f.mapping = set;
    }
    renderFilePanels();
    mergeFilesAndProcess();
    alert('Applied recommended mappings and re-merged. Check Upload mappings and Diagnostics if needed.');
  }

  function switchTab(tab){
    qsa('.tabpane').forEach(p=>p.classList.remove('active'));
    qs('#'+tab).classList.add('active');
    // No fullscreen mode: raceline is scrollable in main content
    document.body.classList.remove('map-fullscreen');
    removeMapCloseButton();
  }

  // Create a small close button when map is fullscreen so users can exit and regain full UI control
  function createMapCloseButton(){
    if(qs('#mapClose')) return;
    const btn = document.createElement('button'); btn.id='mapClose'; btn.textContent='Exit Map View';
    btn.addEventListener('click', ()=>{ document.body.classList.remove('map-fullscreen'); btn.remove(); });
    document.body.appendChild(btn);
  }
  function removeMapCloseButton(){ const b = qs('#mapClose'); if(b) b.remove(); }

  // File handling
  function handleFiles(fileList){
    if(!fileList || fileList.length===0) return;
    const files = Array.from(fileList);
    state.files = [];
    renderFilePanels();
    showProgress(0,'Reading files...');
    let completed = 0;
    const results = [];
    files.forEach((file, idx)=>{
      const rdr = new FileReader();
      rdr.onload = e=>{
        try{
          const txt = e.target.result; const parsed = parseCSV(txt);
          results[idx] = {name:file.name, text:txt, parsed:parsed, mapping:inferMapping(parsed.header), enabled:true};
          completed++;
          // update quick progress (0-40%) for reading
          showProgress(Math.round((completed/files.length)*40),'Reading files...');
          // update per-file panel as they arrive
          state.files = results.filter(Boolean);
          renderFilePanels();
          if(completed===files.length){
            // finalize
            state.files = results.map(r=>({name:r.name,text:r.text,parsed:r.parsed,mapping:inferMapping(r.parsed.header),enabled:true}));
            renderFilePanels();
            mergeFilesAndProcess();
            qs('#dataset').textContent = state.files.map(f=>f.name).join(', ');
          }
        }catch(err){alert('Failed to parse '+file.name+': '+err.message)}
      };
      rdr.onerror = err=>{ alert('File read error '+file.name); };
      rdr.readAsText(file);
    });
  }

  function readFilePromise(file){
    return new Promise((resolve,reject)=>{
      const rdr = new FileReader(); rdr.onload = e=>{ try{ const txt = e.target.result; const parsed = parseCSV(txt); resolve({name:file.name,text:txt,parsed}); }catch(err){reject(err)} };
      rdr.onerror = err=>reject(err); rdr.readAsText(file);
    });
  }

  function renderFilePanels(){
    const el = qs('#filePanels'); el.innerHTML='';
    if(!state.files || state.files.length===0){ el.textContent='No files selected.'; return; }
    state.files.forEach((f,idx)=>{
      const panel = document.createElement('div'); panel.className='file-panel';
      const header = document.createElement('h4'); header.innerHTML = `<input type="checkbox" data-idx="${idx}" ${f.enabled? 'checked':''}/> <strong>${f.name}</strong> <span style="color:var(--muted);font-size:12px">(${f.parsed.header.length} cols)</span>`;
      panel.appendChild(header);
      // mapping selector controls
      const keys = ['time','lat','lon','heading','yaw_rate','vx','steer','ax','ay'];
      const mapRow = document.createElement('div'); mapRow.style.display='flex'; mapRow.style.flexWrap='wrap'; mapRow.style.gap='6px'; mapRow.style.marginTop='6px';
      keys.forEach(k=>{
        const wrap = document.createElement('label'); wrap.style.fontSize='12px'; wrap.style.color='var(--muted)'; wrap.style.display='flex'; wrap.style.alignItems='center'; wrap.style.gap='6px';
        const sel = document.createElement('select'); sel.dataset.idx = idx; sel.dataset.key = k; sel.style.fontSize='12px'; sel.style.padding='4px'; sel.style.background='transparent'; sel.style.color='inherit';
        const hdrs = f.parsed.header; const emptyOpt = document.createElement('option'); emptyOpt.value=''; emptyOpt.textContent = '--'; sel.appendChild(emptyOpt);
        hdrs.forEach(h=>{ const o = document.createElement('option'); o.value = h; o.textContent = h; if(f.mapping && f.mapping[k]===h) o.selected=true; sel.appendChild(o); });
        wrap.innerHTML = `<strong style="color:#fff;margin-right:6px">${k}</strong>`;
        wrap.appendChild(sel);
        mapRow.appendChild(wrap);
      });
      panel.appendChild(mapRow);
      const mappingDiv = document.createElement('div'); mappingDiv.style.fontSize='12px'; mappingDiv.style.color='var(--muted)'; mappingDiv.textContent = 'Auto-detected: ' + Object.entries(f.mapping).map(kv=>kv[0]+':'+(kv[1]||'<n>')).join(', ');
      panel.appendChild(mappingDiv);
      const preview = document.createElement('div'); preview.className='file-preview';
      const rowsPreview = f.parsed.rows.slice(0,5).map(r=> JSON.stringify(Object.fromEntries(Object.entries(r).slice(0,6))) ).join('\n');
      preview.textContent = rowsPreview;
      panel.appendChild(preview);
      el.appendChild(panel);
    });
    // checkbox handlers
    el.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.addEventListener('change', e=>{ const i=parseInt(cb.dataset.idx); state.files[i].enabled = cb.checked; mergeFilesAndProcess(); }));
    // mapping select handlers
    el.querySelectorAll('select').forEach(sel=>sel.addEventListener('change', e=>{ const i=parseInt(sel.dataset.idx); const key = sel.dataset.key; const val = sel.value || null; state.files[i].mapping = state.files[i].mapping || {}; state.files[i].mapping[key]= val; mergeFilesAndProcess(); }));
    // checkbox handlers
    el.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.addEventListener('change', e=>{ const i=parseInt(cb.dataset.idx); state.files[i].enabled = cb.checked; mergeFilesAndProcess(); }));
  }

  // Merge files: choose GNSS-like primary timeline when available, else union/unique times
  function mergeFilesAndProcess(){
    if(!state.files || state.files.length===0) return;
    const enabled = state.files.filter(f=>f.enabled);

    // Auto-apply sensible mappings for common headers (yaw_rate, vx, steer, time)
    function autoApplyMappings(){
      if(!state.files) return;
      state.files.forEach(f=>{
        f.mapping = f.mapping || {};
        const hdrs = f.parsed && f.parsed.header ? f.parsed.header.slice() : [];
        const lower = hdrs.map(h=>String(h).toLowerCase());
        // time: prefer anything with 'time'/'gps'/'week'/'ms' or fall back to first header
        if(!f.mapping.time){
          let t = hdrs[ lower.findIndex(h=>/time|gps|week|ms|epoch|stamp/.test(h)) ];
          if(!t && hdrs.length) t = hdrs[0];
          if(t) f.mapping.time = t;
        }
        // yaw_rate: prefer angular_velocity_z or angular_z or yaw
        if(!f.mapping.yaw_rate){
          const i = lower.findIndex(h=>/angular_velocity_z|angular_velocity.z|angular_z|angular.z|yaw_rate|gz|yaw/.test(h));
          if(i>=0) f.mapping.yaw_rate = hdrs[i];
        }
        // vx: prefer linear_x or vx-like fields
        if(!f.mapping.vx){
          const i = lower.findIndex(h=>/linear_x|linear.x|\bvx\b|velocity_x|groundspeed|speed/.test(h));
          if(i>=0) f.mapping.vx = hdrs[i];
        }
        // steer: prefer commanded_steering_rate or steer-like fields but avoid counters
        if(!f.mapping.steer){
          const i = lower.findIndex(h=>/commanded_steering_rate|steering_rate|steering_cmd|steering_motor|steering_feedback|steer(?!_counter)/.test(h));
          if(i>=0 && !/counter|cnt|seq|index|id/.test(lower[i])) f.mapping.steer = hdrs[i];
        }
      });
      renderFilePanels();
    }

    autoApplyMappings();

    // If a mapped scalar `vx` (e.g., `linear_x`) is present with reasonable data,
    // prefer it immediately to avoid using a noisy `vx_body` signal.
    if(state.vx && Array.isArray(state.vx)){
      const finiteMapped = state.vx.filter(v=>isFinite(v));
      if(finiteMapped.length > 5){
        state.diagnostics = state.diagnostics || {};
        state.diagnostics.preferred_vx_source = 'mapped_vx_present';
        state.vx_preferred_source = 'mapped_vx';
      }
    }

    // Lightly clean obvious spikes in `vx_body` so downstream heuristics aren't fooled.
    if(state.vx_body && Array.isArray(state.vx_body)){
      const absFin = state.vx_body.filter(v=>isFinite(v)).map(v=>Math.abs(v));
      const medianAbs = (()=>{ if(!absFin.length) return 0; const s = absFin.slice().sort((a,b)=>a-b); const m = Math.floor(s.length/2); return s.length%2? s[m] : (s[m-1]+s[m])/2; })();
      const thresh = Math.max(100, medianAbs * 10);
      const cleaned = state.vx_body.map(v=>{ if(!isFinite(v)) return NaN; return Math.abs(v) > thresh ? NaN : v; });
      state.vx_body = cleaned;
    }
          // prefer the mapped scalar `vx` (e.g., linear_x) over `vx_body` when vx_body contains spikes
          if(state.vx && state.vx_body){
            const finiteA = state.vx.filter(v=>isFinite(v)).map(v=>Math.abs(v));
            const finiteB = state.vx_body.filter(v=>isFinite(v)).map(v=>Math.abs(v));
            const median = arr => { if(!arr||arr.length===0) return NaN; const s = arr.slice().sort((a,b)=>a-b); const m = Math.floor(s.length/2); return s.length%2? s[m] : (s[m-1]+s[m])/2; };
            const mad = arr => { const med = median(arr); const dev = arr.map(v=>Math.abs(v-med)); return median(dev); };
            if(finiteA.length>5 && finiteB.length>5){
              const medA = median(finiteA); const medB = median(finiteB);
              const madA = mad(finiteA); const madB = mad(finiteB);
              // If vx_body looks noisy (very large median or MAD) prefer mapped vx
              if(!isFinite(medB) || medB > 100 || madB > Math.max(5, madA*5)){
                state.diagnostics = state.diagnostics || {}; state.diagnostics.preferred_vx_source = 'mapped_vx_due_to_noisy_vx_body'; state.vx_preferred_source = 'mapped_vx';
                // keep existing mapped vx (state.vx) unchanged
              } else if(Math.abs(medA - medB)/Math.max(medA,1e-3) > 0.3){
                // if they differ moderately, choose the one with smaller MAD
                if(madA <= madB){ state.vx_preferred_source = 'mapped_vx'; } else { state.vx_preferred_source = 'vx_body'; state.vx = state.vx_body.slice(); }
              } else {
                state.vx_preferred_source = 'mapped_vx';
              }
            }
          }
    

    // collect time arrays per file using their inferred mapping (robust parsing: numeric, ms epoch, ISO)
    const fileTimes = enabled.map(f=>{
      const tkey = f.mapping.time || f.parsed.header[0];
      const rows = f.parsed.rows.map(r=>{
        const raw = r[tkey]; const t = parseTime(raw);
        return isFinite(t)?t:null;
      }).filter(v=>v!==null);
      return {file:f, times:rows};
    });
    // prefer GNSS/top files as base
    let baseTimes = null;
    const gnss = enabled.find(f=>/bestgnss|gps|gnss/i.test(f.name));
    if(gnss){ 
      const tkey = gnss.mapping.time || gnss.parsed.header[0];
      baseTimes = gnss.parsed.rows.map(r=>{
        const raw = r[tkey]; const t = parseTime(raw); return isFinite(t)?t:null;
      }).filter(v=>v!==null);
    }
    if(!baseTimes){ // union of all times
      const all = new Set(); for(const ft of fileTimes) for(const t of ft.times) all.add(t); baseTimes = Array.from(all).sort((a,b)=>a-b);
    }
    // create merged rows: for each time, copy nearest values from each file
    const merged = baseTimes.map(t=>{ return {__t:t}; });
    const tol = 0.25; // nearest neighbor tolerance (s)

    // Helper: binary search nearest index in sorted numeric array
    function nearestIndex(sortedArr, value){
      let lo = 0, hi = sortedArr.length - 1;
      if(hi < 0) return -1;
      if(value <= sortedArr[0]) return 0;
      if(value >= sortedArr[hi]) return hi;
      while(lo <= hi){
        const mid = Math.floor((lo + hi)/2);
        const mv = sortedArr[mid];
        if(mv === value) return mid;
        if(mv < value) lo = mid + 1; else hi = mid - 1;
      }
      // lo is insertion point; compare neighbors
      const i1 = Math.max(0, lo-1); const i2 = Math.min(sortedArr.length-1, lo);
      return (Math.abs(sortedArr[i1]-value) <= Math.abs(sortedArr[i2]-value))? i1 : i2;
    }

    // Precompute numeric times and rows for each file to enable fast lookup
    const fileData = enabled.map(f=>{
      const tkey = f.mapping.time || f.parsed.header[0];
      const rows = f.parsed.rows.map(r=>{
        const raw = r[tkey]; const t = parseTime(raw);
        return {t: isFinite(t)? t : NaN, row: r};
      }).filter(x=>isFinite(x.t)).sort((a,b)=>a.t-b.t);
      const times = rows.map(x=>x.t);
      return {file:f, times: times, rows: rows, header: f.parsed.header, tkey: tkey};
    });

    // Normalize times if they're in milliseconds (detect large epoch values)
    try{
      const maxBase = baseTimes && baseTimes.length? Math.max(...baseTimes) : 0;
      if(maxBase > 1e11){ // likely milliseconds epoch -> convert to seconds
        baseTimes = baseTimes.map(t=>t/1000.0);
      }
      // normalize per-file times too
      fileData.forEach(fd=>{
        if(fd && fd.times && fd.times.length){ const maxT = Math.max(...fd.times); if(maxT>1e11){ fd.times = fd.times.map(t=>t/1000.0); fd.rows.forEach(r=>{ r.t = r.t/1000.0; }); }
        }
      });
    }catch(e){console.warn('Time normalization check failed',e)}

    // For each merged time, find nearest per-file using binary search (fast)
    for(const fdat of fileData){
      const times = fdat.times; const rows = fdat.rows; const header = fdat.header; const tkey = fdat.tkey;
      if(times.length===0) continue;
      for(let mi=0; mi<merged.length; mi++){
        const m = merged[mi];
        const idx = nearestIndex(times, m.__t);
        if(idx<0) continue;
        const best = rows[idx].row; const bestd = Math.abs(rows[idx].t - m.__t);
        if(bestd <= tol){
          for(const h of header){ if(h===tkey) continue; const val = best[h]; m[h] = isFinite(val)? parseFloat(val) : val; }
        }
        // update progress during merging (40..95%) — coarse
        if(mi % 500 === 0){
          const mergeProgress = 40 + Math.round((mi/merged.length)*55);
          showProgress(mergeProgress, `Merging data (${mergeProgress}%)`);
        }
      }
    }
    // merging complete -> show near-complete
    showProgress(95,'Finalizing...');
    // assign merged to state.data (normalize __t to relative seconds)
    // if times look like epoch ms or large, normalize to start
    const t0 = merged[0].__t || 0; for(const m of merged) m.__t = m.__t - t0;
    state.data = merged;
    // If planner_status/raceline information is present in merged rows, extract it for lap detection
    try{
      const rlKey = 'raceline_index'; const swKey = 'switching_raceline';
      if(state.data && state.data.length && (state.data[0][rlKey] !== undefined || state.data[0][swKey] !== undefined)){
        state.raceline_index = state.data.map(r=>{
          const v = r[rlKey]; if(v===undefined || v===null) return NaN; const s = String(v).trim(); if(s === '' ) return NaN; const n = parseFloat(s); return isFinite(n)? n : (s.toLowerCase()==='true'? 1 : (s.toLowerCase()==='false'? 0 : NaN));
        });
        state.switching_raceline = state.data.map(r=>{ const v = r[swKey]; if(v===undefined||v===null) return false; const s = String(v).trim().toLowerCase(); if(s==='true' || s==='1') return true; if(s==='false' || s==='0') return false; const num = parseFloat(s); return isFinite(num) ? !!num : false; });
        // compute most-frequent raceline index
        const counts = {}; for(const v of state.raceline_index){ if(!isFinite(v)) continue; counts[v] = (counts[v]||0) + 1; }
        let main = null, best=0; for(const k in counts){ if(counts[k] > best){ best = counts[k]; main = parseFloat(k); } }
        if(main !== null){ state.mainRaceline = main; state.diagnostics = state.diagnostics || {}; state.diagnostics.mainRaceline = {value: main, count: best}; }
      } else {
        state.raceline_index = null; state.switching_raceline = null; state.mainRaceline = null;
      }
    }catch(e){ console.warn('Failed to extract raceline info',e); state.raceline_index = null; state.switching_raceline = null; state.mainRaceline = null; }
    // collect union of all keys across merged rows (some files add columns later)
    const colsSet = new Set(); for(const m of merged){ Object.keys(m||{}).forEach(k=>colsSet.add(k)); }
    state.columns = Array.from(colsSet);
    // record mapping central time key
    state.mapping.time = '__t';
    // choose a preferred lat/lon mapping from available files (prefer GNSS)
    try{
      const enabledFiles = enabled;
      let pref = enabledFiles.find(f=>/bestgnss|gps|gnss/i.test(f.name));
      if(!pref) pref = enabledFiles.find(f=>f.mapping && f.mapping.lat && f.mapping.lon);
      if(!pref) pref = enabledFiles.find(f=>/path/i.test(f.name));
      if(pref && pref.mapping){
        if(pref.mapping.lat && pref.mapping.lon){ 
          state.mapping.lat = pref.mapping.lat; state.mapping.lon = pref.mapping.lon;
          // Quick heuristic: sample merged rows and detect if lat/lon appear swapped (common for Path files)
          try{
            const sampleCount = Math.min(200, merged.length);
            const latVals = [], lonVals = [];
            for(let i=0;i<sampleCount;i++){ const m = merged[i]; const lv = parseFloat(m[state.mapping.lat]); const lo = parseFloat(m[state.mapping.lon]); if(isFinite(lv)) latVals.push(lv); if(isFinite(lo)) lonVals.push(lo); }
            if(latVals.length>10 && lonVals.length>10){
              const latMin = Math.min(...latVals), latMax = Math.max(...latVals);
              const lonMin = Math.min(...lonVals), lonMax = Math.max(...lonVals);
              // If lat looks outside latitude bounds while lon looks like latitude, assume swap
              if((latMin < -90 || latMax > 90) && (lonMin >= -90 && lonMax <= 90)){
                const oldLat = state.mapping.lat; state.mapping.lat = state.mapping.lon; state.mapping.lon = oldLat;
                console.log('Auto-swapped lat/lon mapping due to detected ranges:', {newLat:state.mapping.lat, newLon:state.mapping.lon});
              }
            }
          }catch(e){console.warn('Lat/lon swap detection failed',e)}
        }
      }
    }catch(e){console.warn('Failed to pick preferred lat/lon mapping',e)}
    // compute derived signals asynchronously so the UI can update
    setTimeout(()=>{
      try{
        computeAll(); renderAll();
        showProgress(100,'Done');
        setTimeout(hideProgress,400);
        // validate merged results and show helpful guidance if key signals missing
        validateMergedResults();
      }catch(err){
        console.error('Error finalizing merge:', err);
        alert('Error during final processing: '+err.message);
        hideProgress();
      }
    },50);
  }

  function validateMergedResults(){
    // Check if we have position data
    const mappingEl = qs('#mapping');
    if(!state.x || state.x.filter(v=>isFinite(v)).length===0){
      // Build diagnostic message listing per-file mapping status
      let msg = '<div style="padding:10px;background:#2b2f33;border-radius:6px;color:#ffdede"><strong>No position data found after merge.</strong> Please ensure at least one enabled file has both <em>lat</em> and <em>lon</em> mapped to numeric columns.</div>';
      msg += '<div style="margin-top:8px;color:var(--muted)">File mappings:</div><ul style="color:var(--muted)">';
      (state.files||[]).forEach(f=>{
        const m = f.mapping || {};
        msg += `<li><strong>${f.name}</strong>: time=${m.time||'<n>'}, lat=${m.lat||'<n>'}, lon=${m.lon||'<n>'}</li>`;
      });
      msg += '</ul>';
      mappingEl.innerHTML = msg;
      console.warn('Merged dataset has no position data. Current file mappings:', state.files.map(f=>({name:f.name,mapping:f.mapping}))); 
      // attempt auto-detect lat/lon candidates across enabled files
      const autoApplied = tryAutoFindLatLon();
      if(autoApplied){
        mappingEl.innerHTML += '<div style="margin-top:8px;color:#bfe">Auto-applied lat/lon mapping and re-merging — if this looks incorrect, adjust mappings manually.</div>'; 
        return true;
      }
      return false;
    } else {
      // restore mapping panel to auto-detected summary
      renderMapping();
      return true;
    }
  }

  function tryAutoFindLatLon(){
    if(!state.files) return false;
    // search every enabled file for a pair of headers that look like lat/lon
    for(const f of state.files){
      if(!f.enabled) continue;
      const hdrs = f.parsed && f.parsed.header? f.parsed.header : [];
      if(hdrs.length<2) continue;
      // evaluate numeric score for each header
      const scores = {};
      for(const h of hdrs){ let c=0, tot=0, min=Infinity, max=-Infinity; for(const r of f.parsed.rows){ const v = parseFloat(r[h]); tot++; if(isFinite(v)){ c++; if(v<min) min=v; if(v>max) max=v; }} scores[h] = {count:c,total:tot,min,max}; }
      // find pairs where one fits lat range (-90..90) and other fits lon (-180..180)
      const candidates = [];
      for(const a of hdrs){ for(const b of hdrs){ if(a===b) continue; const sa=scores[a], sb=scores[b]; if(!sa||!sb) continue; const fracA = sa.count/sa.total; const fracB = sb.count/sb.total; if(fracA<0.5 || fracB<0.5) continue; if(sa.min>=-90 && sa.max<=90 && sb.min>=-180 && sb.max<=180){ candidates.push({lat:a,lon:b,score:sa.count+sb.count}); } }
      }
      if(candidates.length>0){ candidates.sort((x,y)=>y.score-x.score); const best = candidates[0]; f.mapping = f.mapping || {}; f.mapping.lat = best.lat; f.mapping.lon = best.lon; console.log('Auto-detected lat/lon for',f.name, best); renderFilePanels(); mergeFilesAndProcess(); return true; }
    }
    return false;
  }

  // Diagnostics UI
  function showDiagnostics(){
    // remove existing
    const existing = qs('#diagOverlay'); if(existing) existing.remove();
    const o = document.createElement('div'); o.id='diagOverlay';
    const close = document.createElement('button'); close.id='diagClose'; close.textContent='Close'; close.addEventListener('click',()=>o.remove()); o.appendChild(close);
    const h = document.createElement('h3'); h.textContent='Diagnostics'; o.appendChild(h);
    const summary = document.createElement('div');
    const filesSummary = (state.files||[]).map(f=>{
      const rows = f.parsed && f.parsed.rows? f.parsed.rows.length : 0;
      return {name:f.name, enabled:f.enabled, rows:rows, mapping:f.mapping};
    });
    const mergedCount = state.data? state.data.length : 0;
    const hasPos = state.x && state.x.filter(v=>isFinite(v)).length>0;
    summary.innerHTML = `<div><strong>Files:</strong> ${filesSummary.map(f=>f.name).join(', ')}</div><div><strong>Merged rows:</strong> ${mergedCount}</div><div><strong>Has positions:</strong> ${hasPos}</div>`;
    o.appendChild(summary);
    const pre = document.createElement('pre'); pre.textContent = 'Per-file mapping and first 3 rows (merged):\n' + filesSummary.map(f=> JSON.stringify(f,null,2)).join('\n'); o.appendChild(pre);

    const mergedPreview = document.createElement('pre'); mergedPreview.textContent = 'Merged sample rows:\n' + (state.data? JSON.stringify(state.data.slice(0,5),null,2) : 'no merged data'); o.appendChild(mergedPreview);
    const diagJson = document.createElement('pre'); diagJson.textContent = 'Computed diagnostics:\n' + JSON.stringify(state.diagnostics||{},null,2); o.appendChild(diagJson);
    // if alpha_f≈alpha_r, offer steering candidate helper
    if(state.diagnostics && state.diagnostics.alpha_f_r_too_similar){
      const helper = document.createElement('div'); helper.style.marginTop='8px'; helper.innerHTML = '<strong>Alpha similarity detected.</strong> <button id="steerCandBtn">Show steering column candidates</button> — click to inspect possible steering headers and force a mapping.';
      o.appendChild(helper);
      setTimeout(()=>{ const btn = qs('#steerCandBtn'); if(btn) btn.addEventListener('click', showSteeringCandidates); },50);
    }
    document.body.appendChild(o);
    console.log('Diagnostics output — state.files:', state.files); console.log('state.data sample:', state.data && state.data.slice(0,5)); console.log('mappings:', state.files && state.files.map(f=>({name:f.name,mapping:f.mapping}))); 
  }

  // Show steering candidates: lists numeric headers from steering files excluding counters
  function showSteeringCandidates(){
    const candidates = [];
    for(const f of state.files || []){
      if(!/steer|steering/.test(f.name.toLowerCase())) continue;
      const hdrs = f.parsed && f.parsed.header? f.parsed.header : [];
      for(const h of hdrs){
        const vals = f.parsed.rows.slice(0,200).map(r=>{ const v=parseFloat(r[h]); return isFinite(v)? v : NaN; }).filter(v=>isFinite(v));
        if(vals.length<20) continue;
        // skip likely counters
        const intLikeFrac = vals.filter(v=>Math.abs(v-Math.round(v))<1e-6).length / vals.length;
        const monotonic = vals.slice(1).every((v,i)=> v >= vals[i]);
        if(intLikeFrac>0.9 && monotonic) continue;
        const mean = vals.reduce((s,v)=>s+v,0)/vals.length; const variance = vals.reduce((s,v)=>s+(v-mean)*(v-mean),0)/vals.length;
        candidates.push({file:f.name, header:h, mean, variance, sample: f.parsed.rows.slice(0,3).map(r=>r[h])});
      }
    }
    // Render a small overlay with candidates
    const existing = qs('#steerCandOverlay'); if(existing) existing.remove(); const o = document.createElement('div'); o.id='steerCandOverlay'; o.style.position='fixed'; o.style.zIndex=99999; o.style.left='10%'; o.style.top='10%'; o.style.width='40%'; o.style.maxHeight='70%'; o.style.overflow='auto'; o.style.background='rgba(2,6,10,0.97)'; o.style.padding='12px'; o.style.border='1px solid rgba(255,255,255,0.06)'; o.style.borderRadius='8px';
    const close = document.createElement('button'); close.textContent='Close'; close.addEventListener('click', ()=>o.remove()); o.appendChild(close);
    const h = document.createElement('h3'); h.textContent = 'Steering column candidates'; o.appendChild(h);
    if(candidates.length===0){ const p=document.createElement('div'); p.textContent='No non-counter numeric candidates found in steering files.'; o.appendChild(p); document.body.appendChild(o); return; }
    const table = document.createElement('table'); table.style.width='100%'; table.style.borderCollapse='collapse'; table.innerHTML = '<tr><th>File</th><th>Header</th><th>Variance</th><th>Sample (first 3)</th><th>Action</th></tr>';
    for(const c of candidates.sort((a,b)=>b.variance-a.variance)){
      const tr = document.createElement('tr'); tr.style.borderTop='1px solid rgba(255,255,255,0.04)'; tr.innerHTML = `<td>${c.file}</td><td>${c.header}</td><td>${c.variance.toFixed(3)}</td><td>${c.sample.map(s=>String(s)).join(', ')}</td><td><button class="forceSteerBtn" data-file="${c.file}" data-header="${c.header}">Force map</button></td>`;
      table.appendChild(tr);
    }
    o.appendChild(table); document.body.appendChild(o);
    // attach handlers
    o.querySelectorAll('.forceSteerBtn').forEach(b=>b.addEventListener('click', e=>{ const file = b.dataset.file; const hdr = b.dataset.header; forceSetSteeringMapping(file,hdr); o.remove(); }));
  }

  function forceSetSteeringMapping(fileName, header){
    for(const f of state.files){ if(f.name===fileName){ f.mapping = f.mapping || {}; f.mapping.steer = header; break; } }
    renderFilePanels(); mergeFilesAndProcess(); alert('Forced steering mapping to '+header+' for file '+fileName+' and re-merged.');
  }

  // CSV parser (simple)
  // Robust CSV parser that handles quoted fields (RFC4180-ish)
  function parseCSV(text){
    const rows = [];
    let cur = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    const pushField = ()=>{ cur.push(field); field = ''; };
    while(i < text.length){
      const ch = text[i];
      const ch2 = text[i+1];
      if(inQuotes){
        if(ch === '"'){
          if(ch2 === '"'){ field += '"'; i += 1; } else { inQuotes = false; }
        } else { field += ch; }
      } else {
        if(ch === '"'){ inQuotes = true; }
        else if(ch === ','){ pushField(); }
        else if(ch === '\r') { /* ignore */ }
        else if(ch === '\n') { pushField(); rows.push(cur); cur = []; }
        else { field += ch; }
      }
      i++;
    }
    // push last
    if(field.length>0 || inQuotes || cur.length>0){ pushField(); rows.push(cur); }
    if(rows.length===0) return {header:[],rows:[]};
    const header = rows.shift().map(h=>h.trim());
    const dataRows = rows.map(r=>{
      const obj = {};
      for(let j=0;j<header.length;j++) obj[header[j]] = (r[j]===undefined? '': r[j]);
      return obj;
    });
    return {header, rows: dataRows};
  }

  // Parse time-like strings into seconds (supports numeric, epoch ms, ISO, and 'sec=.. nanosec=..' patterns)
  function parseTime(raw){
    if(raw===undefined || raw===null) return NaN;
    if(typeof raw === 'number') return raw;
    let s = String(raw).trim();
    // strip surrounding quotes
    if(s.startsWith('"') && s.endsWith('"')) s = s.slice(1,-1).trim();
    // look for sec= / nanosec=
    const secMatch = s.match(/sec=(\d+)/);
    const nsecMatch = s.match(/nanosec=(\d+)/);
    if(secMatch){ const sec = parseInt(secMatch[1],10); const nsec = nsecMatch? parseInt(nsecMatch[1],10):0; return sec + nsec/1e9; }
    // numeric
    const num = parseFloat(s);
    if(isFinite(num)) return num;
    // ISO-like
    const dt = Date.parse(s);
    if(!isNaN(dt)) return dt/1000.0;
    return NaN;
  }

  // Infer mapping
  function inferMapping(header){
    const map = {};
    const lower = header.map(h=>h.toLowerCase());
    const find = pats=>{for(const p of pats){const i=lower.findIndex(h=>h.includes(p)); if(i>=0) return header[i]}return null};
    map.time = find(['time','timestamp','t']) || header[0];
    map.lat = find(['lat','latitude'])||find(['y'])||null;
    map.lon = find(['lon','longitude','lng'])||find(['x'])||null;
    map.heading = find(['heading','yaw','psi'])||null;
    map.yaw_rate = find(['yaw_rate','yawrate','omega','gz'])||null;
    map.vx = find(['vx','speed','v_x','velocity'])||null;
    map.steer = find(['steer','steering'])||null;
    map.ax = find(['ax','accel_x','accx','longitudinal'])||null;
    map.ay = find(['ay','accel_y','accy','lateral'])||null;
    return map;
  }

  // Process CSV
  function processCSV(text){
    const parsed = parseCSV(text);
    state.columns = parsed.header;
    state.mapping = inferMapping(parsed.header);
    // convert rows into numeric arrays
    const rows = parsed.rows.map(r=>{
      const o = {};
      for(const k in r) o[k]=isFinite(r[k])?parseFloat(r[k]):r[k];
      return o;
    });
    state.rawRows = rows;
    // build time series using detected time
    const timeKey = state.mapping.time || parsed.header[0];
    const times = rows.map(r=>{const v=r[timeKey]; return typeof v==='number'?v:parseTime(v)}).filter(v=>!isNaN(v));
    if(times.length===0) {alert('No numeric time column detected');}
    // normalize time to seconds relative
    const t0 = times[0];
    for(let i=0;i<rows.length;i++){const t=parseTime(rows[i][timeKey]); rows[i].__t = isNaN(t)?(i===0?0:i-1):(t - t0);}    
    state.data = rows;
    renderMapping();
    computeAll();
    renderAll();
  }

  function renderMapping(){
    const el = qs('#mapping'); el.innerHTML = '';
    const m = state.mapping;
    const ul = document.createElement('div');
    ul.innerHTML = '<strong>Detected columns</strong><div style="color:var(--muted)">You can override by editing the mapping object in the console if needed.</div>';
    const list = document.createElement('ul');
    for(const k of Object.keys(m)){
      const li = document.createElement('li'); li.textContent = k+': '+(m[k]||'<not found>'); list.appendChild(li);
    }
    el.appendChild(ul); el.appendChild(list);
  }

  // Signal processing helpers
  function toNumericArray(key){return state.data.map(d=>isFinite(d[key])?d[key]:NaN)}
  function movingAverage(arr,win){const out=new Array(arr.length);const k=Math.max(1,Math.floor(win));for(let i=0;i<arr.length;i++){let s=0,c=0;for(let j=Math.max(0,i-k);j<=Math.min(arr.length-1,i+k);j++){if(isFinite(arr[j])){s+=arr[j];c++}}out[i]=c? s/c:NaN}return out}
  function derivative(arr,dt){const out=new Array(arr.length);for(let i=0;i<arr.length;i++){if(i===0) out[i]=NaN; else out[i]=(arr[i]-arr[i-1])/(dt[i]-dt[i-1]||0.001)}return out}

  // Compute core signals
  function computeAll(){
    if(!state.data) return;
    const n = state.data.length;
    // time vector
    const t = state.data.map(d=>d.__t);
    state.t = t;
    // Promote per-file mappings (user-selected in Upload panel) to global `state.mapping`.
    // Priority: imu_vectornav -> velocity_body_vectornav -> steering_report -> Path -> GNSS
    try{
      // If a Path file (e.g. Path.csv) is present and enabled, prefer it explicitly
      // as the source of position (raceline) before other heuristics.
      const pathFile = (state.files||[]).find(f=>f.enabled && /\bpath\b/i.test(f.name));
      if(pathFile && pathFile.mapping){
        state.mapping.lat = state.mapping.lat || pathFile.mapping.lat;
        state.mapping.lon = state.mapping.lon || pathFile.mapping.lon;
        state.mapping._sources = state.mapping._sources || {};
        if(pathFile.mapping.lat) state.mapping._sources.lat = pathFile.name;
        if(pathFile.mapping.lon) state.mapping._sources.lon = pathFile.name;
      }
      const preferOrder = ['imu_vectornav','velocity_body_vectornav','steering_report','path','bestgnsspos','gps','gnss'];
      const filesByPriority = (state.files||[]).slice().filter(f=>f.enabled).sort((a,b)=>{
        const ai = preferOrder.findIndex(p=>a.name.toLowerCase().includes(p)); const bi = preferOrder.findIndex(p=>b.name.toLowerCase().includes(p)); return ai - bi;
      });
      state.mapping = state.mapping || {};
      const promote = (key)=>{
        for(const f of filesByPriority){ if(f.mapping && f.mapping[key]){ state.mapping._sources = state.mapping._sources || {}; state.mapping._sources[key] = f.name; return f.mapping[key]; } }
        return state.mapping[key] || null;
      };
      state.mapping.yaw_rate = promote('yaw_rate') || state.mapping.yaw_rate;
      state.mapping.steer = promote('steer') || state.mapping.steer;
      state.mapping.vx = promote('vx') || state.mapping.vx;
      state.mapping.ax = promote('ax') || state.mapping.ax;
      state.mapping.ay = promote('ay') || state.mapping.ay;
      state.mapping.heading = promote('heading') || state.mapping.heading;
    }catch(e){ console.warn('Failed to promote per-file mappings', e); }

    // Ensure global mapping entries exist for common signals by scanning merged columns
    try{
      const cols = state.columns || Object.keys(state.data[0]||{});
      // normalize column names for easier matching
      const lowerCols = (cols||[]).map(c=>String(c).toLowerCase());
      // helper to pick header avoiding counter-like names
      const pick = (patterns)=>{
        const h = findHeader(cols, patterns) || null;
        if(h && /counter|cnt|index/.test(String(h).toLowerCase())) return null;
        return h;
      };
      state.mapping = state.mapping || {};
      state.mapping.yaw_rate = state.mapping.yaw_rate || pick(['angular_velocity_z_/vectornav/imu','angular_velocity_z','angular_z','gz','yaw_rate','angular_z_/vectornav/imu']);
      state.mapping.steer = state.mapping.steer || pick(['steering_angle','steering_wheel_angle','steering','steering_motor_fdbk','commanded_steering_rate']);
      if(state.mapping.steer && /counter/.test(String(state.mapping.steer).toLowerCase())) state.mapping.steer = null;
      // if steer still missing but merged columns include 'commanded_steering_rate', force it
      if(!state.mapping.steer){ const cmdIdx = lowerCols.findIndex(c=>c.includes('commanded_steering_rate')); if(cmdIdx>=0) state.mapping.steer = cols[cmdIdx]; }
      state.mapping.vx = state.mapping.vx || pick(['linear_x','vx','velocity_x','speed']);
      state.mapping.ax = state.mapping.ax || pick(['linear_acceleration_x_/vectornav/imu','linear_acceleration_x','accel_x','ax','acceleration_x']);
      state.mapping.ay = state.mapping.ay || pick(['linear_acceleration_y_/vectornav/imu','linear_acceleration_y','accel_y','ay','acceleration_y']);
      state.mapping.heading = state.mapping.heading || pick(['heading','yaw','psi']);
      // if yaw_rate still missing but merged columns include angular_velocity_z_/vectornav/imu pick it
      if(!state.mapping.yaw_rate){ const aIdx = lowerCols.findIndex(c=>c.includes('angular_velocity_z') || c.includes('angular_z_/vectornav')); if(aIdx>=0) state.mapping.yaw_rate = cols[aIdx]; }
      // If `vx` was accidentally picked from an IMU angular field (common auto-detect mistake),
      // prefer any velocity-like header across uploaded files (linear_x, current_state_velocity_x, speed, vx)
      try{
        const vxBad = state.mapping.vx && /angular_velocity|angular_x|angular_y|angular_z/.test(String(state.mapping.vx).toLowerCase());
        if(vxBad || !state.mapping.vx){
          const preferVxNames = ['linear_x','current_state_velocity_x','current_velocity_x','velocity_x','vx','speed','groundspeed'];
          let found = null;
          for(const f of (state.files||[])){
            const hdrs = f.parsed && f.parsed.header ? f.parsed.header : [];
            for(const name of preferVxNames){
              const idx = hdrs.findIndex(h=>String(h).toLowerCase().includes(name));
              if(idx>=0){ found = {file:f.name, header: hdrs[idx]}; break; }
            }
            if(found) break;
          }
          if(found){ state.mapping.vx = found.header; state.mapping._sources = state.mapping._sources || {}; state.mapping._sources.vx = found.file; }
        }
      }catch(e){/* non-fatal */}

      // Force `linear_x` if present in any uploaded file -- highest priority for vehicle forward speed
      try{
        for(const f of (state.files||[])){
          const hdrs = f.parsed && f.parsed.header ? f.parsed.header : [];
          const li = hdrs.find(h=>String(h).toLowerCase().trim() === 'linear_x' || String(h).toLowerCase().includes('linear_x'));
          if(li){ state.mapping.vx = li; state.mapping._sources = state.mapping._sources || {}; state.mapping._sources.vx = f.name; break; }
        }
      }catch(e){/* non-fatal */}
    }catch(e){console.warn('Auto-populate global mapping failed',e)}
    // positions
    const latKey = state.mapping.lat; const lonKey = state.mapping.lon;
    if(latKey && lonKey){
      // raw geographic degrees
      const lonVals = state.data.map(d=>parseFloat(d[lonKey]));
      const latVals = state.data.map(d=>parseFloat(d[latKey]));
      state.lon_deg = lonVals.slice(); state.lat_deg = latVals.slice();
      // decide whether these are geographic degrees or local meters
      const finiteLat = latVals.filter(v=>isFinite(v)); const finiteLon = lonVals.filter(v=>isFinite(v));
      const degLatCount = finiteLat.filter(v=>v>=-90 && v<=90).length;
      const degLonCount = finiteLon.filter(v=>v>=-180 && v<=180).length;
      const degFraction = ( (degLatCount + degLonCount) / Math.max(1, (finiteLat.length + finiteLon.length)) );
      if(degFraction > 0.75){
        // treat as degrees -> convert to local meters (equirectangular)
        const meanLat = finiteLat.reduce((s,v)=>s+v,0)/finiteLat.length;
        const R = 6371000; const deg2rad = Math.PI/180; const cosLat = Math.cos(meanLat*deg2rad);
        const lat0 = finiteLat[0]||0; const lon0 = finiteLon[0]||0;
        state.x = lonVals.map(l=> isFinite(l)? ((l - lon0)*deg2rad*R*cosLat) : NaN);
        state.y = latVals.map(lat=> isFinite(lat)? ((lat - lat0)*deg2rad*R) : NaN);
        state._posUnits = 'deg';
      } else {
        // treat as local meters already
        state.x = lonVals.map(v=> isFinite(v)? v : NaN);
        state.y = latVals.map(v=> isFinite(v)? v : NaN);
        state._posUnits = 'm';
      }
      // simple world velocities
      const dt = []; for(let i=0;i<n;i++) dt.push(i===0?0.01: t[i]-t[i-1]);
      const vxw = derivative(state.x,dt); const vyw = derivative(state.y,dt);
      state.vx_world = vxw; state.vy_world = vyw; 
      // heading
      const headingKey = state.mapping.heading;
      if(headingKey){ state.heading = state.data.map(d=>parseFloat(d[headingKey])); }
      else{ // infer heading from velocity vector
        state.heading = state.vx_world.map((vx,i)=>Math.atan2((state.vy_world[i]||0),(vx||0)));
      }
      // transform to body frame
      state.vx_body = []; state.vy_body = [];
      for(let i=0;i<n;i++){
        const vxw_i = state.vx_world[i]||0; const vyw_i = state.vy_world[i]||0; const psi = state.heading[i]||0;
        state.vx_body[i] = Math.cos(psi)*vxw_i + Math.sin(psi)*vyw_i;
        state.vy_body[i] = -Math.sin(psi)*vxw_i + Math.cos(psi)*vyw_i;
      }
      // slip estimate basic
      state.beta_basic = state.vy_body.map((vy,i)=>{const vx = state.vx_body[i]||1e-3; return Math.atan2(vy||0,vx);});

      // Prefer a mapped scalar `vx` (linear_x etc.) when it has sufficient valid samples;
      // otherwise fall back to computed `vx_body` (but `vx_body` was pre-cleaned earlier).
      if(state.vx && Array.isArray(state.vx)){
        const finiteMapped = state.vx.filter(v=>isFinite(v));
        if(finiteMapped.length > Math.max(5, n*0.05)){
          state.diagnostics = state.diagnostics || {}; state.diagnostics.preferred_vx_source = 'mapped_vx'; state.vx_preferred_source = 'mapped_vx';
          // keep mapped vx
        } else if(state.vx_body && Array.isArray(state.vx_body)){
          state.diagnostics = state.diagnostics || {}; state.diagnostics.preferred_vx_source = 'vx_body_fallback'; state.vx_preferred_source = 'vx_body'; state.vx = state.vx_body.slice();
        }
      } else if(state.vx_body && Array.isArray(state.vx_body)){
        state.vx = state.vx_body.slice(); state.vx_preferred_source = 'vx_body';
      }
    }

    // yaw rate
    if(state.mapping.yaw_rate) state.yaw_rate = state.data.map(d=>parseFloat(d[state.mapping.yaw_rate]));
    // if yaw_rate mostly missing, try sampling from an IMU/vectornav file present in uploads
    if((!state.yaw_rate || (state.yaw_rate.filter(v=>isFinite(v)).length < Math.max(5, n*0.05))) && state.files && state.files.length){
      // find a file with vectornav or imu in the name
      const imuFile = state.files.find(f=>/vectornav|imu|ins/i.test(f.name));
      if(imuFile){
        // pick likely angular z header
        const hdr = (imuFile.parsed && imuFile.parsed.header||[]).find(h=>/angular_velocity_z|angular_z|gz|yaw_rate/.test(String(h)));
        if(hdr){
          const sampled = sampleFieldFromFile(imuFile.name, hdr);
          const fin = sampled.filter(v=>isFinite(v)).length;
          if(fin > Math.max(5, n*0.02)){
            state.yaw_rate = sampled.slice(); state.diagnostics = state.diagnostics||{}; state.diagnostics.yaw_rate_sampled_from = imuFile.name; state.mapping.yaw_rate = hdr;
          }
        }
      }
    }

    // Helper: sample a column from its original file onto merged timeline using nearest neighbor
    function sampleFieldFromFile(fileName, header){
      const f = (state.files||[]).find(x=>x.name===fileName);
      if(!f) return new Array(n).fill(NaN);
      // build times and values for file if not cached
      if(!f._cachedTimes){
        const tkey = f.mapping && f.mapping.time ? f.mapping.time : f.parsed.header[0];
        f._cachedTimes = f.parsed.rows.map(r=>{ const tt = parseTime(r[tkey]); return isFinite(tt)? tt : NaN; });
        f._cachedVals = {};
      }
      // ensure values cached for header
      if(!f._cachedVals[header]){
        f._cachedVals[header] = f.parsed.rows.map(r=>{ const v = parseFloat(r[header]); return isFinite(v)? v : NaN; });
      }
      const times = f._cachedTimes; const vals = f._cachedVals[header];
      // nearest lookup (assume times sorted roughly as original order)
      const out = new Array(n).fill(NaN);
      // build relative file times
      const validTimes = times.filter(t=>isFinite(t));
      if(validTimes.length===0){
        // fallback to proportional resampling
        for(let i=0;i<n;i++){ const fi = Math.round(i * (vals.length-1) / Math.max(1,n-1)); out[i] = vals[fi]; }
        return out;
      }
      const t0f = validTimes[0]; const tfLast = validTimes[validTimes.length-1]; const fileRange = tfLast - t0f;
      const mergedRange = (state.t && state.t.length>1)? (state.t[state.t.length-1] - state.t[0]) : 0;
      // normalize file relative times
      const fileRel = times.map(t=> isFinite(t)? (t - t0f) : NaN);
      // If ranges look comparable, use time-nearest mapping; otherwise use proportional index mapping
      if(fileRange>0 && mergedRange>0 && (fileRange/mergedRange > 0.5 && fileRange/mergedRange < 2.0)){
        for(let i=0;i<n;i++){
          const mt = state.t[i]; // merged times are relative
          // find nearest file index by comparing to fileRel
          let bestIdx=-1, bestD=Number.POSITIVE_INFINITY;
          for(let j=0;j<fileRel.length;j++){ const tt = fileRel[j]; if(!isFinite(tt)) continue; const d = Math.abs(tt - mt); if(d<bestD){ bestD=d; bestIdx=j; } }
          if(bestIdx>=0) out[i] = vals[bestIdx];
        }
        // if too many NaNs, fallback to proportional
        const fin = out.filter(v=>isFinite(v)).length;
        if(fin < Math.max(5, n*0.02)){
          for(let i=0;i<n;i++){ const fi = Math.round(i * (vals.length-1) / Math.max(1,n-1)); out[i] = vals[fi]; }
        }
      } else {
        // proportional resample
        for(let i=0;i<n;i++){ const fi = Math.round(i * (vals.length-1) / Math.max(1,n-1)); out[i] = vals[fi]; }
      }
      return out;
    }

    // Auto-detect yaw_rate units (deg/s vs rad/s) and convert if necessary
    if(state.yaw_rate){
      const absVals = state.yaw_rate.filter(v=>isFinite(v)).map(v=>Math.abs(v));
      if(absVals.length>0){ const meanAbs = absVals.reduce((s,v)=>s+v,0)/absVals.length; // if typical values look like degrees/sec (>> 5) convert
        if(meanAbs > 5){ state.yaw_rate = state.yaw_rate.map(v=> isFinite(v)? v * Math.PI/180 : v); state.diagnostics = state.diagnostics||{}; state.diagnostics.yaw_rate_converted_from_deg = true; }
      }
      // light smoothing
      state.yaw_rate = movingAverage(state.yaw_rate,2);
    }

    // speed vx
    if(state.mapping.vx) state.vx = state.data.map(d=>parseFloat(d[state.mapping.vx]));
    else state.vx = state.vx_body;

    // light smoothing for vx
    if(state.vx) state.vx = movingAverage(state.vx,2);

    // If a mapped vx header exists (from a file), prefer it and interpolate missing values
    try{
      const mappedHeader = state.mapping && state.mapping.vx;
      const srcFile = state.mapping && state.mapping._sources && state.mapping._sources.vx;
      const interp = (arr)=>{
        const out = arr.slice();
        const n = out.length;
        // find finite indices
        const finiteIdx = [];
        for(let i=0;i<n;i++) if(isFinite(out[i])) finiteIdx.push(i);
        if(finiteIdx.length===0) return out;
        // fill leading
        for(let i=0;i<finiteIdx[0];i++) out[i]=out[finiteIdx[0]];
        // fill between
        for(let k=0;k<finiteIdx.length-1;k++){
          const i = finiteIdx[k], j = finiteIdx[k+1];
          const vi = out[i], vj = out[j];
          const steps = j - i;
          for(let m=1;m<steps;m++){ out[i+m] = vi + (vj-vi)*(m/steps); }
        }
        // fill trailing
        for(let i=finiteIdx[finiteIdx.length-1]+1;i<n;i++) out[i]=out[finiteIdx[finiteIdx.length-1]];
        return out;
      };
      if(mappedHeader){
        // count finite in the mapped series
        const mappedFin = (state.vx||[]).filter(v=>isFinite(v)).length;
        const useIf = mappedFin > Math.max(5, state.t.length*0.02);
        if(useIf){
          const beforeNaNs = (state.vx||[]).filter(v=>!isFinite(v)).length;
          state.vx = interp(state.vx || []);
          const afterNaNs = (state.vx||[]).filter(v=>!isFinite(v)).length;
          state.diagnostics = state.diagnostics || {};
          state.diagnostics.preferred_vx_source = 'mapped_vx_interpolated';
          state.diagnostics.mapped_vx_finite_count = mappedFin;
          state.diagnostics.mapped_vx_nans_before = beforeNaNs;
          state.diagnostics.mapped_vx_nans_after = afterNaNs;
          state.vx_preferred_source = 'mapped_vx_interpolated';
        }
      }
    }catch(e){/* non-fatal */}

    // imu ay
    if(state.mapping.ay) state.ay = state.data.map(d=>parseFloat(d[state.mapping.ay]));

    // vehicle params from UI
    const veh = {};
    veh.m = parseFloat(qs('#mass')?.value || 1500);
    veh.wheelbase = parseFloat(qs('#wheelbase')?.value || 2.5);
    veh.lf = parseFloat(qs('#lf')?.value || (veh.wheelbase*0.45));
    veh.lr = parseFloat(qs('#lr')?.value || (veh.wheelbase - veh.lf));
    veh.Cf = parseFloat(qs('#Cf')?.value || 80000);
    veh.Cr = parseFloat(qs('#Cr')?.value || 80000);
    veh.Iz = parseFloat(qs('#Iz')?.value || 300);
    state.vehicle = veh;

    // compute slip dynamic (integrate vy from ay if available)
    if(state.ay && state.vx){
      const vy = []; vy[0]=0; for(let i=1;i<n;i++){const dt = (t[i]-t[i-1])||0.01; const vx = Math.abs(state.vx[i]||0.1); const omega = (state.yaw_rate?state.yaw_rate[i]:0); const vy_dot = (state.ay[i]||0) - vx*omega; vy[i] = vy[i-1] + vy_dot*dt; }
      state.vy_dynamic = vy;
      state.beta_dynamic = vy.map((v,i)=>Math.atan2(v,Math.max(0.1,Math.abs(state.vx[i]||1))));
    }

    // Steering / computed tire slip angles (instantaneous geometry)
    if(state.mapping.steer){
      // raw steering values (could be angle or steering rate)
      const steerHeader = state.mapping.steer;
      // if we know which file provided the steer mapping and it is a rate, sample from that file onto merged times
      let steerRaw = state.data.map(d=>{ const v = parseFloat(d[steerHeader]); return isFinite(v)? v : NaN; });
      if(state.diagnostics && state.diagnostics.steer_from_rate && state.mapping._sources && state.mapping._sources.steer){
        const src = state.mapping._sources.steer;
        const sampled = sampleFieldFromFile(src, steerHeader);
        // if sampled has many finite values, prefer it
        const finCount = sampled.filter(v=>isFinite(v)).length;
        if(finCount > (n*0.05)) steerRaw = sampled;
      }
      // find header name to check for 'rate'
      const steerKey = String(state.mapping.steer || '').toLowerCase();
      // basic stats
      const rawVals = steerRaw.filter(v=>isFinite(v));
      const meanAbs = rawVals.length? rawVals.map(Math.abs).reduce((s,v)=>s+v,0)/rawVals.length : 0;
      const variance = rawVals.length? rawVals.reduce((s,v)=>s+(v- (rawVals.reduce((a,b)=>a+b,0)/rawVals.length))*(v-(rawVals.reduce((a,b)=>a+b,0)/rawVals.length)),0)/rawVals.length : 0;
      // decide if this is a steering rate (header contains 'rate' or values look like deg/s)
      const looksLikeRate = steerKey.includes('rate') || steerKey.includes('rate') || meanAbs > 2 && variance > 1;
      if(looksLikeRate){
        // convert to rad/s if appears to be degrees/s
        let steerRate = steerRaw.slice();
        if(meanAbs > 5) steerRate = steerRate.map(v=> isFinite(v)? v * Math.PI/180 : NaN);
        // remove DC bias from rate (median) before integration to avoid drift
        const finiteRates = steerRate.filter(v=>isFinite(v));
        const median = (arr=>{ if(!arr||arr.length===0) return 0; const s=arr.slice().sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2? s[m] : (s[m-1]+s[m])/2; })(finiteRates.map(v=>v));
        steerRate = steerRate.map(v=> isFinite(v)? (v - median) : NaN);
        // integrate rate -> angle (initial angle = 0), clamp to reasonable steering angle bounds
        const steerAngle = new Array(n).fill(NaN);
        steerAngle[0] = 0;
        const clamp = (v,lim)=> Math.max(-lim, Math.min(lim, v));
        const steerLimit = Math.PI/3; // 60 degrees
        for(let i=1;i<n;i++){
          const dt = (t[i]-t[i-1]) || 0.01;
          const r = isFinite(steerRate[i])? steerRate[i] : (isFinite(steerRate[i-1])? steerRate[i-1] : 0);
          steerAngle[i] = clamp(steerAngle[i-1] + r * dt, steerLimit);
        }
        state.steer = steerAngle;
        state.diagnostics = state.diagnostics || {}; state.diagnostics.steer_from_rate = true; state.diagnostics.steer_source = state.mapping.steer;
      } else {
        // treat as direct steering angle
        state.steer = steerRaw.map(v=> isFinite(v)? v : 0);
        if(meanAbs > 3.5) state.steer = state.steer.map(v=> v * Math.PI/180);
      }

    // smooth steering angles a little to remove integration jitter
    if(state.steer) state.steer = movingAverage(state.steer,3).map(v=> isFinite(v)? v : 0);
    } else {
      state.steer = new Array(n).fill(0);
    }

    // If yaw_rate is mostly missing in merged data but we have an IMU file source, sample it onto merged times
    if((!state.yaw_rate || state.yaw_rate.filter(v=>isFinite(v)).length < Math.max(5, n*0.01)) && state.mapping._sources && state.mapping._sources.yaw_rate){
      const sampledYaw = sampleFieldFromFile(state.mapping._sources.yaw_rate, state.mapping.yaw_rate);
      const finiteCount = sampledYaw.filter(v=>isFinite(v)).length;
      if(finiteCount > (n*0.01)) state.yaw_rate = sampledYaw.map(v=> isFinite(v)? v: NaN);
    }

    // compute instantaneous tire slip angles alpha_f, alpha_r using body velocities and yaw rate
    state.alpha_f = new Array(n).fill(NaN); state.alpha_r = new Array(n).fill(NaN);
    // adaptive min speed threshold: prefer UI override `#minVx` but otherwise derive from median speed
    const parseMinVxUI = parseFloat(qs('#minVx')?.value);
    const mappedVxAbs = (state.vx||[]).filter(v=>isFinite(v)).map(Math.abs);
    const medianOf = arr=>{ if(!arr||arr.length===0) return NaN; const s=arr.slice().sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2? s[m] : (s[m-1]+s[m])/2; };
    const medianAbsVx = medianOf(mappedVxAbs);
    const defaultThresh = isFinite(medianAbsVx)? Math.max(0.05, medianAbsVx*0.1) : 0.05;
    let minVxForAlpha = isFinite(parseMinVxUI) ? parseMinVxUI : defaultThresh;
    let alphaSkipped = 0;
    const computeAlphas = (threshold)=>{
      alphaSkipped = 0;
      for(let i=0;i<n;i++){
        const vxRaw = (state.vx && isFinite(state.vx[i]))? state.vx[i] : (state.vx_body? state.vx_body[i] : NaN);
        const vx = isFinite(vxRaw)? vxRaw : NaN;
        const vy = (state.vy_body && isFinite(state.vy_body[i]))? state.vy_body[i] : (state.vy_dynamic? state.vy_dynamic[i] : 0);
        const r = (state.yaw_rate && isFinite(state.yaw_rate[i]))? state.yaw_rate[i] : 0;
        const delta = state.steer[i]||0;
        if(isFinite(vx) && Math.abs(vx) >= threshold){
          const vx_for_calc = Math.abs(vx) < threshold ? Math.sign(vx||1)*threshold : vx;
          state.alpha_f[i] = delta - Math.atan2( (vy + r*state.vehicle.lf), vx_for_calc );
          state.alpha_r[i] = - Math.atan2( (vy - r*state.vehicle.lr), vx_for_calc );
        } else { state.alpha_f[i]=NaN; state.alpha_r[i]=NaN; alphaSkipped++; }
      }
    };
    computeAlphas(minVxForAlpha);
    // If everything was skipped, relax threshold and try again (use a small floor)
    if(alphaSkipped === n){
      const fallback = isFinite(medianAbsVx)? Math.max(0.01, medianAbsVx*0.02) : 0.01;
      minVxForAlpha = Math.min(minVxForAlpha, fallback) || fallback;
      computeAlphas(minVxForAlpha);
    }
    state.diagnostics = state.diagnostics || {}; state.diagnostics.alpha_samples_skipped_for_low_speed = alphaSkipped; state.diagnostics.minVxForAlpha_used = minVxForAlpha;

    // Simple linear bicycle model forward integration (one-step Euler) to predict vy and r and hence beta
    state.beta_pred = new Array(n).fill(NaN);
    if(state.vx && state.alpha_f && state.alpha_r){
      // initialize with measured vy / yaw if available
      let vy_pred = (state.vy_body && isFinite(state.vy_body[0]))? state.vy_body[0] : 0;
      let r_pred = (state.yaw_rate && isFinite(state.yaw_rate[0]))? state.yaw_rate[0] : 0;
      for(let i=0;i<n-1;i++){
        const dt = (state.t[i+1]-state.t[i]) || 0.01;
        const vx_i = Math.max(minVxForAlpha, Math.abs(state.vx[i] || state.vx_body[i] || minVxForAlpha));
        const delta = state.steer[i]||0;
        // compute alphas from predicted vy/r
        const alpha_f_pred = delta - Math.atan2( (vy_pred + r_pred*state.vehicle.lf), vx_i );
        const alpha_r_pred = - Math.atan2( (vy_pred - r_pred*state.vehicle.lr), vx_i );
        // forces (linear tire)
        const Fyf = 2 * state.vehicle.Cf * alpha_f_pred; // factor 2 for two front tires
        const Fyr = 2 * state.vehicle.Cr * alpha_r_pred;
        // dynamics
        const vy_dot = ( -vx_i * r_pred + ( -Fyf - Fyr ) / state.vehicle.m );
        const r_dot = ( (-state.vehicle.lf * Fyf + state.vehicle.lr * Fyr) / state.vehicle.Iz );
        // integrate
        vy_pred = vy_pred + vy_dot * dt;
        r_pred = r_pred + r_dot * dt;
        state.beta_pred[i+1] = Math.atan2(vy_pred, vx_i);
      }
    }

    // Diagnostics: detect suspicious constant or identical arrays
    state.diagnostics = state.diagnostics || {};
    try{
      const deg = arr=> (arr||[]).map(v=> isFinite(v)? v*180/Math.PI : NaN);
      const stats = (a)=>{ const vals = (a||[]).filter(v=>isFinite(v)); if(vals.length===0) return null; return {min:Math.min(...vals), max:Math.max(...vals), mean: vals.reduce((s,v)=>s+v,0)/vals.length}; };
      const bstats = stats(deg(state.beta_basic)); const afstats = stats(deg(state.alpha_f)); const arstats = stats(deg(state.alpha_r));
      state.diagnostics.beta_stats = bstats; state.diagnostics.alpha_f_stats = afstats; state.diagnostics.alpha_r_stats = arstats;
      // flag if any series is essentially constant or if alpha_f ~ alpha_r across samples
      const isConst = s=> s && (Math.abs(s.max - s.min) < 1e-6);
      state.diagnostics.beta_constant = bstats? (Math.abs(bstats.max - bstats.min) < 1e-6) : false;
      state.diagnostics.alpha_f_constant = afstats? (Math.abs(afstats.max - afstats.min) < 1e-6) : false;
      state.diagnostics.alpha_r_constant = arstats? (Math.abs(arstats.max - arstats.min) < 1e-6) : false;
      // check near-identical alpha_f vs alpha_r (within 0.01 deg)
      if(afstats && arstats){
        const diffs = []; for(let i=0;i<n;i++){ const A = isFinite(state.alpha_f[i])? state.alpha_f[i]*180/Math.PI : NaN; const B = isFinite(state.alpha_r[i])? state.alpha_r[i]*180/Math.PI : NaN; if(isFinite(A) && isFinite(B)) diffs.push(Math.abs(A-B)); }
        const maxdiff = diffs.length? Math.max(...diffs) : NaN; state.diagnostics.alpha_maxdiff = maxdiff;
        state.diagnostics.alpha_f_r_too_similar = isFinite(maxdiff) ? (maxdiff < 0.01) : false;
        // If alpha_f and alpha_r are suspiciously identical, capture a few sample values for debugging
        if(state.diagnostics.alpha_f_r_too_similar){
          state.diagnostics.alpha_debug_samples = [];
          for(let i=0;i<n && state.diagnostics.alpha_debug_samples.length<8;i++){
            if(!isFinite(state.alpha_f[i]) || !isFinite(state.alpha_r[i])) continue;
            state.diagnostics.alpha_debug_samples.push({
              idx:i,
              t: state.t && state.t[i],
              vx: isFinite(state.vx && state.vx[i])? state.vx[i] : (isFinite(state.vx_body && state.vx_body[i])? state.vx_body[i] : null),
              vy_body: isFinite(state.vy_body && state.vy_body[i])? state.vy_body[i] : (isFinite(state.vy_dynamic && state.vy_dynamic[i])? state.vy_dynamic[i] : null),
              yaw_rate: isFinite(state.yaw_rate && state.yaw_rate[i])? state.yaw_rate[i] : null,
              steer: isFinite(state.steer && state.steer[i])? state.steer[i] : null,
              lf: state.vehicle && state.vehicle.lf, lr: state.vehicle && state.vehicle.lr,
              alpha_f_deg: state.alpha_f[i]*180/Math.PI, alpha_r_deg: state.alpha_r[i]*180/Math.PI
            });
          }
          console.warn('Alpha_f ≈ Alpha_r detected — sample debug:', state.diagnostics.alpha_debug_samples);
        }
      }
    }catch(e){ console.warn('Diagnostics check failed',e); }

    // Flag GPS dropouts: missing pos or large dt gaps
    state.gps_drop_zones = [];
    for(let i=1;i<n;i++){const dt = t[i]-t[i-1]; if(dt>0.25) state.gps_drop_zones.push({start:t[i-1],end:t[i]});}

    // compute raceline (reference) as smoothed path
    if(state.x && state.y){
      const sx = movingAverage(state.x,3); const sy = movingAverage(state.y,3);
      state.ref = {x:sx,y:sy};
      // compute mapping from time samples to nearest reference indices and detect corners
      try{ state.closestRefIndex = computeClosestRefIndices(state.x,state.y,state.ref.x,state.ref.y); detectCorners(); }catch(e){console.warn('Corner detection failed',e)}
      try{ computeLapsFromStart(); }catch(e){console.warn('Lap computation failed', e)}
      // cross-track error
      state.cte = computeCTE(state.x,state.y,sx,sy);
      const abs = state.cte.map(v=>Math.abs(v));
      state.metrics.maxDev = Math.max(...abs.filter(v=>isFinite(v))); state.metrics.meanDev = (abs.reduce((a,b)=>a+(isFinite(b)?b:0),0)/abs.length)||0;
      // time over threshold
      const thr = state.settings.devThresh||0.4; state.metrics.timeOver = state.t.filter((tt,i)=>Math.abs(state.cte[i]||0)>thr).length*( (state.t[1]-state.t[0])||0.01 );
    }

    // Tire fit: Fy = m*ay
    if(state.ay){ const m = parseFloat(qs('#mass').value||1500); state.Fy = state.ay.map(a=>a*m); }
    if(state.Fy && state.beta_basic){ fitTireModel(); }
    // Expose internal state for debugging in browser console (temporary)
    try{ window.__SA_STATE = state; console.log('Exposed internal state as window.__SA_STATE (temporary)'); }catch(e){}
  }

  function computeCTE(x,y,rx,ry){
    const n = x.length; const cte = new Array(n).fill(0);
    // For each sample, find nearest point on ref polyline
    for(let i=0;i<n;i++){
      let best=1e9; let sign=1;
      for(let j=0;j<rx.length-1;j++){
        const x1=rx[j], y1=ry[j], x2=rx[j+1], y2=ry[j+1];
        const px = x[i], py=y[i];
        const vx = x2-x1, vy=y2-y1; const wx = px-x1, wy=py-y1; const c = (wx*vx+wy*vy)/(vx*vx+vy*vy||1e-9); const cx = x1 + c*vx; const cy = y1 + c*vy; const d2 = (px-cx)**2+(py-cy)**2; if(d2<best){best=d2; const cross = (vx*(py-y1)-vy*(px-x1)); sign = cross>=0?1:-1}
      }
      cte[i] = sign*Math.sqrt(best);
    }
    return cte;
  }

  // Compute nearest reference index for each sample (used to tie time->raceline)
  function computeClosestRefIndices(x,y,rx,ry){
    const n = x.length; const m = rx.length; const nearest = new Array(n).fill(0);
    for(let i=0;i<n;i++){
      let best=1e18; let bi=0;
      for(let j=0;j<m;j++){ const dx = x[i]-rx[j]; const dy = y[i]-ry[j]; const d2 = dx*dx+dy*dy; if(d2<best){ best=d2; bi=j; } }
      nearest[i]=bi;
    }
    // build reverse mapping from ref index -> sample indices for fast lookup
    try{
      const refToSamples = new Array(m); for(let j=0;j<m;j++) refToSamples[j]=[];
      for(let i=0;i<n;i++){ const r = nearest[i]; if(r>=0 && r < m) refToSamples[r].push(i); }
      state.refToSamples = refToSamples;
    }catch(e){ state.refToSamples = null; }
    return nearest;
  }

  // Compute lap numbers relative to a chosen start reference index
  function computeLapsFromStart(){
    state.lapNumbers = null; state.lapCount = 0; state.lapBoundaries = null;
    if(!state.closestRefIndex || !state.t || !state.ref || !state.x) return;
    const n = state.closestRefIndex.length;
    // If user specified a start ref index, build a local start line (point + normal) and detect signed crossings
    if(state.startRefIdx != null && isFinite(state.startRefIdx)){
      const ridx = state.startRefIdx;
      const rx = state.ref.x[ridx] || 0, ry = state.ref.y[ridx] || 0;
      // approximate tangent from nearby ref points
      const im1 = Math.max(0, ridx-2), ip1 = Math.min(state.ref.x.length-1, ridx+2);
      const tx = (state.ref.x[ip1] - state.ref.x[im1]) || 1e-6; const ty = (state.ref.y[ip1] - state.ref.y[im1]) || 0;
      const tmag = Math.sqrt(tx*tx + ty*ty) || 1e-6; const tnx = tx / tmag, tny = ty / tmag;
      // normal pointing across track
      const nx = -tny, ny = tnx;
      // compute signed distance for each sample to the line
      const signs = new Array(n).fill(0);
      for(let i=0;i<n;i++){ const xi = state.x[i], yi = state.y[i]; if(!isFinite(xi) || !isFinite(yi)){ signs[i] = NaN; continue; } signs[i] = ( (xi - rx) * nx + (yi - ry) * ny ); }
      // detect zero-crossings from negative->positive where forward velocity along tangent is positive
      const crossings = [];
      const minLapTime = (state.lapParams && isFinite(state.lapParams.minLapTime))? state.lapParams.minLapTime : 6.0;
      const minForward = (state.lapParams && isFinite(state.lapParams.forwardSpeedThreshold))? state.lapParams.forwardSpeedThreshold : 0.2;
      let lastT = -1e9;
      for(let i=1;i<n;i++){
        const s0 = signs[i-1], s1 = signs[i]; if(!isFinite(s0) || !isFinite(s1)) continue;
        if(s0 < 0 && s1 >= 0){ // crossed forward
          // interpolate crossing time between i-1 and i for better accuracy
          const denom = (Math.abs(s1 - s0) || 1e-9); const frac = Math.abs(s0) / denom; const tNow = state.t[i-1] + frac * ((state.t[i] - state.t[i-1]) || 0);
          if((tNow - lastT) < minLapTime) continue; // debounce
          // If planner raceline data is available, ensure we are on the main raceline and not switching
          if(state.mainRaceline != null && Array.isArray(state.raceline_index)){
            const rIdxVal = state.raceline_index[i]; if(!isFinite(rIdxVal) || rIdxVal !== state.mainRaceline) continue; // ignore crossings while on different raceline
            if(state.switching_raceline && state.switching_raceline[i]) continue; // ignore while switching
          }
          // check forward speed along tangent at sample i (or fallback to averaged nearby velocity)
          const vxw = (state.vx_world && isFinite(state.vx_world[i])? state.vx_world[i] : (state.vx_world && isFinite(state.vx_world[i-1])? state.vx_world[i-1] : NaN));
          const vyw = (state.vy_world && isFinite(state.vy_world[i])? state.vy_world[i] : (state.vy_world && isFinite(state.vy_world[i-1])? state.vy_world[i-1] : NaN));
          const proj = (isFinite(vxw) && isFinite(vyw))? (vxw * tnx + vyw * tny) : NaN;
          if(isFinite(proj) && proj < minForward) continue; // require modest forward motion
          crossings.push({idx:i, t: tNow}); lastT = tNow;
        }
      }
        // If we detected at least one crossing, build lap boundaries such that
        // Lap 0 starts at time 0 and ends at the first crossing, lap 1 begins at first crossing, etc.
        if(crossings.length>=1){ const bounds = [];
          // first lap: start at index 0, end at first crossing-1 (or crossing idx if inclusive)
          const firstEnd = Math.max(0, crossings[0].idx - 1);
          bounds.push({lap:0, startIdx:0, endIdx: firstEnd, startTime: state.t[0]||0, endTime: state.t[firstEnd] || state.t[0] || 0});
          for(let k=0;k<crossings.length;k++){
            const sIdx = crossings[k].idx;
            const eIdx = (k < crossings.length-1)? Math.max(sIdx, crossings[k+1].idx - 1) : (n-1);
            // laps after the first are numbered k+1
            bounds.push({lap:k+1, startIdx: sIdx, endIdx: eIdx, startTime: state.t[sIdx], endTime: state.t[eIdx]});
          }
          // assign lap numbers for all samples
          const lapNums = new Array(n).fill(0);
          for(const b of bounds){ for(let i=b.startIdx;i<=b.endIdx && i<n;i++) lapNums[i] = b.lap; }
          state.lapNumbers = lapNums; state.lapBoundaries = bounds; state.lapCount = bounds.length;
        }
    }
    // fallback: previous wrap heuristic if no start-line crossings
    if(!state.lapNumbers){ // fallback: previous wrap heuristic if no start-line crossings
      const lapNums = new Array(n).fill(0); let lap = 0; let lastLapTime = -1e9; const minLapTimeFb = (state.lapParams && isFinite(state.lapParams.minLapTime))? state.lapParams.minLapTime : 8.0; let prevIdx = state.closestRefIndex[0]; lapNums[0]=0; for(let i=1;i<n;i++){ const curIdx = state.closestRefIndex[i]; if(prevIdx - curIdx > Math.floor(state.ref.x.length*0.4) && (state.t[i] - lastLapTime) > minLapTimeFb){ lap++; lastLapTime = state.t[i]; } lapNums[i] = lap; prevIdx = curIdx; } state.lapNumbers = lapNums; state.lapCount = Math.max(0, lap); const bounds = []; let curLap = lapNums[0], s = 0; for(let i=1;i<n;i++){ if(lapNums[i] !== curLap){ bounds.push({lap:curLap, startIdx:s, endIdx:i-1, startTime:state.t[s], endTime:state.t[i-1]}); curLap = lapNums[i]; s = i; } } bounds.push({lap:curLap, startIdx:s, endIdx:n-1, startTime:state.t[s], endTime:state.t[n-1]}); state.lapBoundaries = bounds; }
    // populate lap selector (preserve previous selection if possible)
    const sel = qs('#lapSelect'); if(sel){ const prev = sel.value || null; sel.innerHTML=''; const allOpt = document.createElement('option'); allOpt.value='all'; allOpt.textContent='All'; sel.appendChild(allOpt); if(state.lapBoundaries) for(let L=0; L<state.lapBoundaries.length; L++){ const o = document.createElement('option'); o.value = String(L); o.textContent = 'Lap '+(L+1); sel.appendChild(o); }
      // try to restore previous selection if still present
      try{ if(prev != null){ const opt = Array.from(sel.options).find(o=>o.value === prev); if(opt) sel.value = prev; } }catch(e){}
    }
    const info = qs('#lapInfo'); if(info){ info.textContent = state.lapBoundaries? `Detected ${state.lapBoundaries.length} laps` : 'No laps detected';
      // add brief diagnostics with last crossings times
      try{ if(state.lapBoundaries && state.lapBoundaries.length){ const times = state.lapBoundaries.map(b=> (b.startTime!=null? b.startTime.toFixed(2)+'s':'?') ); info.textContent += '  (starts: ' + times.join(', ') + ')'; } 
        if(state.mainRaceline != null){ info.textContent += ` — using planner raceline ${state.mainRaceline}`; }
      }catch(e){}
    }
    // Mirror lap info into topbar small span so it's easy to spot
    try{ const top = qs('#lapinfo'); if(top) top.textContent = info? info.textContent : ''; }catch(e){}
    // If raceline data is missing, briefly warn the user in lapInfo
    if(!state.ref || !state.ref.x || state.ref.x.filter(v=>isFinite(v)).length===0){ const iel = qs('#lapInfo'); if(iel) iel.textContent += '  (No reference raceline available)'; const top = qs('#lapinfo'); if(top) top.textContent += '  (No raceline)'; }
  }

  // Discrete curvature for a polyline (central differences)
  function computeCurvature(rx,ry){
    const n = rx.length; const k = new Array(n).fill(0);
    for(let i=1;i<n-1;i++){
      const x1 = rx[i-1], x2 = rx[i], x3 = rx[i+1];
      const y1 = ry[i-1], y2 = ry[i], y3 = ry[i+1];
      const dx1 = x2-x1, dy1 = y2-y1; const dx2 = x3-x2, dy2 = y3-y2;
      const denom = Math.pow((dx1*dx1+dy1*dy1),1.5) + 1e-12;
      const num = dx1*dy2 - dy1*dx2;
      k[i] = num / denom;
    }
    return k;
  }

  // Detect corner regions from curvature peaks and summarize slip stats per corner
  function detectCorners(){
    state.corners = [];
    if(!state.ref || !state.ref.x || state.ref.x.length<5) return;
    const rx = state.ref.x, ry = state.ref.y;
    const curv = computeCurvature(rx,ry).map(v=>Math.abs(v));
    const maxK = Math.max(...curv);
    if(!isFinite(maxK) || maxK===0) return;
    // threshold relative to max curvature
    const thresh = Math.max(1e-4, maxK * 0.25);
    // find contiguous regions where curvature > thresh
    let inRegion=false, start=0;
    for(let i=0;i<curv.length;i++){
      if(curv[i] > thresh && !inRegion){ inRegion=true; start=i; }
      if((curv[i] <= thresh || i===curv.length-1) && inRegion){ const end = i; inRegion=false;
        // compute stats for this ref index interval: find time indices whose closestRefIndex in [start,end]
        const tIdx = [];
        if(state.closestRefIndex){ for(let ti=0; ti<state.closestRefIndex.length; ti++){ const ri = state.closestRefIndex[ti]; if(ri>=start && ri<=end) tIdx.push(ti); } }
        // summarize
        const bet = tIdx.map(i=> (state.beta_basic && isFinite(state.beta_basic[i])? state.beta_basic[i]*180/Math.PI : NaN)).filter(v=>isFinite(v));
        const pred = tIdx.map(i=> (state.beta_pred && isFinite(state.beta_pred[i])? state.beta_pred[i]*180/Math.PI : NaN)).filter(v=>isFinite(v));
        const af = tIdx.map(i=> (state.alpha_f && isFinite(state.alpha_f[i])? state.alpha_f[i]*180/Math.PI : NaN)).filter(v=>isFinite(v));
        const ar = tIdx.map(i=> (state.alpha_r && isFinite(state.alpha_r[i])? state.alpha_r[i]*180/Math.PI : NaN)).filter(v=>isFinite(v));
        const stats = {refStart:start, refEnd:end, count:tIdx.length, meanBeta: (bet.length? bet.reduce((a,b)=>a+b,0)/bet.length: NaN), maxBeta: (bet.length? Math.max(...bet): NaN), meanBetaPred: (pred.length? pred.reduce((a,b)=>a+b,0)/pred.length: NaN), maxBetaPred: (pred.length? Math.max(...pred): NaN), meanAlphaF: (af.length? af.reduce((a,b)=>a+b,0)/af.length: NaN), meanAlphaR: (ar.length? ar.reduce((a,b)=>a+b,0)/ar.length: NaN)};
        // apex (center) ref index
        stats.apex = Math.floor((start+end)/2);
        state.corners.push(stats);
      }
    }
  }

  // Simple tire model fit (Fy = a*beta + b*beta^3)
  function fitTireModel(){
    const bet = state.beta_basic.map(b=>isFinite(b)?b:0); const Fy = state.Fy; const n = Math.min(bet.length,Fy.length);
    const A = []; const B = [];
    for(let i=0;i<n;i++){ if(isFinite(bet[i]) && isFinite(Fy[i])){A.push([bet[i], Math.pow(bet[i],3)]); B.push(Fy[i]);}}
    if(A.length<3) { state.tireFit = null; return; }
    // least squares for two params
    let ATA=[[0,0],[0,0]]; let ATB=[0,0];
    for(let i=0;i<A.length;i++){ATA[0][0]+=A[i][0]*A[i][0]; ATA[0][1]+=A[i][0]*A[i][1]; ATA[1][0]=ATA[0][1]; ATA[1][1]+=A[i][1]*A[i][1]; ATB[0]+=A[i][0]*B[i]; ATB[1]+=A[i][1]*B[i];}
    const det = ATA[0][0]*ATA[1][1]-ATA[0][1]*ATA[1][0]; if(Math.abs(det)<1e-12) return; const inv = [[ATA[1][1]/det, -ATA[0][1]/det],[-ATA[1][0]/det, ATA[0][0]/det]];
    const a = inv[0][0]*ATB[0]+inv[0][1]*ATB[1]; const b = inv[1][0]*ATB[0]+inv[1][1]*ATB[1];
    state.tireFit = {a,b};
    // fit quality (R2)
    const mean = B.reduce((s,v)=>s+v,0)/B.length; let ssr=0,sst=0; for(let i=0;i<B.length;i++){const pred=a*A[i][0]+b*A[i][1]; ssr+=(B[i]-pred)**2; sst+=(B[i]-mean)**2;} state.tireFit.r2 = 1-ssr/sst;
  }

  // Rendering
  function renderAll(){
    renderTopbar(); renderMap(); renderDeviationChart(); renderSlipChart(); renderTireFit(); renderGPS(); renderControllerStatus();
    // ensure interactive handlers are attached once
    attachSlipInteractions(); attachMapInteractions();
  }

  function renderTopbar(){
    qs('#dataset').textContent = qs('#dataset').textContent || 'No dataset';
    qs('#deviationSummary').textContent = state.metrics.maxDev? ` Max dev ${state.metrics.maxDev.toFixed(2)} m`:'';
    qs('#gpsDrops').textContent = state.gps_drop_zones? ` GPS drop zones: ${state.gps_drop_zones.length}`:'';
    // diagnostics banner
    const status = qs('#status');
    if(state.diagnostics){
      let msg = '';
      if(state.diagnostics.alpha_f_r_too_similar) msg += ' ⚠️ alpha_f ≈ alpha_r (possible units/frame issue).';
      if(state.diagnostics.alpha_f_constant || state.diagnostics.alpha_r_constant) msg += ' ⚠️ alpha series constant (check mappings).';
      if(state.diagnostics.beta_constant) msg += ' ⚠️ beta constant (check vx/vy).';
      if(msg) qs('#dataset').textContent = (qs('#dataset').textContent||'') + ' ' + msg;
    }
  }

  function renderMap(){
    const svg = qs('#map'); while(svg.firstChild) svg.removeChild(svg.firstChild);
    if(!state.x) return;
    const padding=60; const W=800, H=400;
    const rawX = state.x || []; const rawY = state.y || [];
    // filter indices with finite coordinates
    const validIdx = [];
    for(let i=0;i<rawX.length;i++){ if(isFinite(rawX[i]) && isFinite(rawY[i])) validIdx.push(i); }
    if(validIdx.length===0) return;
    const xs = validIdx.map(i=>rawX[i]); const ys = validIdx.map(i=>rawY[i]);
    let minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
    // prevent degenerate ranges
    if(minx===maxx){ minx -= 0.5; maxx += 0.5; }
    if(miny===maxy){ miny -= 0.5; maxy += 0.5; }
    // Vertical visual offset to avoid overlapping the top UI text
    const yShift = 40; // pixels — move raceline down by this amount
    // store projection for interactions (include yShift so interactions map correctly)
    state.mapProj = {minx,maxx,miny,maxy,W,H,padding, yShift};
    const sx= (v)=>padding + ( (v-minx)/(maxx-minx) )*(W-2*padding);
    const sy= (v)=>padding + ( (maxy-v)/(maxy-miny) )*(H-2*padding) + yShift;
    // ref path (use corresponding valid indices) - draw only if user wants to see the reference
    if(state.ref){
      const showRef = qs('#showRef') ? !!qs('#showRef').checked : true;
      const refX = state.ref.x; const refY = state.ref.y;
      // pick reference points that have finite values at same positions and record their SVG coords
      const refPts = [];
      state.refSvg = {x:[], y:[], idx:[]};
      for(let i=0;i<refX.length;i++){ if(isFinite(refX[i]) && isFinite(refY[i])){ const px = sx(refX[i]); const py = sy(refY[i]); refPts.push(px+','+py); state.refSvg.x.push(px); state.refSvg.y.push(py); state.refSvg.idx.push(i); } }
      if(refPts.length>0 && showRef){ const p=document.createElementNS('http://www.w3.org/2000/svg','polyline'); p.setAttribute('fill','none'); p.setAttribute('stroke','#2a9d8f'); p.setAttribute('stroke-width','3'); p.setAttribute('opacity','0.9'); p.setAttribute('points', refPts.join(' ')); svg.appendChild(p);}    
    }
    // driven path
    // draw per-lap driven paths if lap segmentation exists
    if(state.lapNumbers && Array.isArray(state.lapNumbers) && state.lapNumbers.length===state.x.length){
      const colors = ['#ffd166','#ff6b6b','#4dabf7','#2a9d8f','#9b59b6','#e67e22'];
      const maxLap = Math.max(...state.lapNumbers);
      for(let L=0; L<=maxLap; L++){
        const pts = [];
        for(let i=0;i<state.x.length;i++){ if(state.lapNumbers[i]===L && isFinite(state.x[i]) && isFinite(state.y[i])) pts.push(sx(state.x[i])+','+sy(state.y[i])); }
        if(pts.length>0){ const p = document.createElementNS('http://www.w3.org/2000/svg','polyline'); p.setAttribute('fill','none'); p.setAttribute('stroke', colors[L % colors.length]);
          // when showing all laps, use modest stroke; when a single lap is selected, hide others entirely (opacity 0)
          const selVal = (qs('#lapSelect') && qs('#lapSelect').value) ? qs('#lapSelect').value : 'all';
          if(state.showAllLaps){ p.setAttribute('stroke-width','1.5'); p.setAttribute('opacity', selVal==='all'? 0.9 : 0.5); }
          else { if(selVal===String(L)){ p.setAttribute('stroke-width','3'); p.setAttribute('opacity','1.0'); } else { p.setAttribute('stroke-width','1'); p.setAttribute('opacity','0'); } }
          p.setAttribute('points', pts.join(' ')); svg.appendChild(p); }
      }
    } else {
      const drvPts = xs.map((xx,i)=> sx(xx)+','+sy(ys[i]) );
      if(drvPts.length>0){ const p2=document.createElementNS('http://www.w3.org/2000/svg','polyline'); p2.setAttribute('fill','none'); p2.setAttribute('stroke','#ffd166'); p2.setAttribute('stroke-width','2'); p2.setAttribute('points', drvPts.join(' ')); svg.appendChild(p2); }
    }
    // highlight large deviations (map back to original indices)
    const thr = state.settings.devThresh||0.4;
    for(let k=0;k<validIdx.length;k++){ const i = validIdx[k]; if(state.cte && Math.abs(state.cte[i])>thr){ const c=document.createElementNS('http://www.w3.org/2000/svg','circle'); c.setAttribute('cx', sx(xs[k])); c.setAttribute('cy', sy(ys[k])); c.setAttribute('r',3); c.setAttribute('fill', 'rgba(255,77,79,0.9)'); svg.appendChild(c); } }
    // draw corner apex markers (if corners detected)
    // NOTE: corner markers (C1/C2) are hidden by default. To re-enable,
    // set `state.settings.showCorners = true` (e.g., in the console) or
    // change the default in the `state` initializer above.
    if(state.corners && state.corners.length && state.settings && state.settings.showCorners){
      for(const cinfo of state.corners){ const idx = cinfo.apex; if(!isFinite(idx)) continue; const rx = state.ref.x[idx], ry = state.ref.y[idx]; if(!isFinite(rx) || !isFinite(ry)) continue; const cxp = sx(rx), cyp = sy(ry); const m = document.createElementNS('http://www.w3.org/2000/svg','circle'); m.setAttribute('cx',cxp); m.setAttribute('cy',cyp); m.setAttribute('r',6); m.setAttribute('fill','#ff6b00'); m.setAttribute('opacity','0.9'); m.style.cursor='pointer'; m.addEventListener('click', ()=>{ showCornerOverlay(cinfo); }); svg.appendChild(m); const lab = document.createElementNS('http://www.w3.org/2000/svg','text'); lab.setAttribute('x',cxp+8); lab.setAttribute('y',cyp+4); lab.setAttribute('fill','#fff'); lab.setAttribute('font-size','12'); lab.textContent = `C${state.corners.indexOf(cinfo)+1}`; svg.appendChild(lab); }
    }
    // ensure hover marker exists
    if(!qs('#hoverMarker')){ const hm = document.createElementNS('http://www.w3.org/2000/svg','circle'); hm.setAttribute('id','hoverMarker'); hm.setAttribute('r',5); hm.setAttribute('fill','#ffd166'); hm.setAttribute('stroke','#000'); hm.setAttribute('stroke-width','1'); hm.setAttribute('opacity','0.95'); svg.appendChild(hm); }

    // if a start reference index is set, draw a start-line marker (map ref index -> svg coord)
    if(state.startRefIdx != null && state.refSvg && Array.isArray(state.refSvg.idx)){
      const mapIdx = state.refSvg.idx.findIndex(v=>v === state.startRefIdx);
      if(mapIdx >= 0){ const sxv = state.refSvg.x[mapIdx]; const syv = state.refSvg.y[mapIdx]; const line = document.createElementNS('http://www.w3.org/2000/svg','line'); line.setAttribute('x1', sxv); line.setAttribute('y1', syv-30); line.setAttribute('x2', sxv); line.setAttribute('y2', syv+30); line.setAttribute('stroke','#ffffff'); line.setAttribute('stroke-width','2'); line.setAttribute('stroke-dasharray','6,4'); svg.appendChild(line); }
    }
    // render per-lap list (small previews + stats)
    try{ renderLapList(); }catch(e){ /* non-fatal */ }
  }

  // Render a scrollable list of per-lap cards with small SVG and stats
  function renderLapList(){
    const wrap = qs('#lapList'); if(!wrap) return; wrap.innerHTML = '';
    if(!state.lapBoundaries || state.lapBoundaries.length===0){ wrap.innerHTML = '<div style="color:var(--muted);padding:8px">No lap segmentation available. Set a start line and rerun.</div>'; return; }
    const proj = state.mapProj || {minx:0,maxx:1,miny:0,maxy:1,W:800,H:200,padding:10};
    const colors = ['#ffd166','#ff6b6b','#4dabf7','#2a9d8f','#9b59b6','#e67e22'];
    for(const b of state.lapBoundaries){ const card = document.createElement('div'); card.className='card'; card.style.display='flex'; card.style.alignItems='center'; card.style.gap='12px'; card.style.marginBottom='8px'; card.style.padding='8px';
      const svgW = 260, svgH = 120; const s = document.createElementNS('http://www.w3.org/2000/svg','svg'); s.setAttribute('width', String(svgW)); s.setAttribute('height', String(svgH)); s.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`); s.style.background='linear-gradient(180deg,#071017,#071019)'; s.style.borderRadius='6px';
      // small projection for card: reuse map extents but scale to svgW/svgH
      const minx = proj.minx, maxx = proj.maxx, miny = proj.miny, maxy = proj.maxy, pad = 8;
      const sx = v=> pad + ((v - minx) /(maxx - minx || 1))*(svgW - 2*pad);
      const sy = v=> pad + ((maxy - v) /(maxy - miny || 1))*(svgH - 2*pad);
      const pts = [];
      for(let i=b.startIdx;i<=b.endIdx;i++){ if(isFinite(state.x[i]) && isFinite(state.y[i])) pts.push(`${sx(state.x[i])},${sy(state.y[i])}`); }
      if(pts.length>0){ const p = document.createElementNS('http://www.w3.org/2000/svg','polyline'); p.setAttribute('points', pts.join(' ')); p.setAttribute('fill','none'); p.setAttribute('stroke', colors[b.lap % colors.length]); p.setAttribute('stroke-width','2'); s.appendChild(p); }
      // stats column
      const info = document.createElement('div'); info.style.color='var(--muted)'; info.style.fontSize='13px'; info.style.flex='0 0 300px';
      const dur = (b.endTime - b.startTime)||0; const bet = []; const af = []; const ar = [];
      for(let i=b.startIdx;i<=b.endIdx;i++){ if(state.beta_basic && isFinite(state.beta_basic[i])) bet.push(state.beta_basic[i]*180/Math.PI); if(state.alpha_f && isFinite(state.alpha_f[i])) af.push(state.alpha_f[i]*180/Math.PI); if(state.alpha_r && isFinite(state.alpha_r[i])) ar.push(state.alpha_r[i]*180/Math.PI); }
      const mean = arr=> arr.length? (arr.reduce((s,v)=>s+v,0)/arr.length) : NaN; const maxv = arr=> arr.length? Math.max(...arr) : NaN; const minv = arr=> arr.length? Math.min(...arr) : NaN;
      info.innerHTML = `<strong>Lap ${b.lap+1}</strong><br/>Duration: ${dur.toFixed(2)}s<br/>Samples: ${Math.max(0,b.endIdx - b.startIdx +1)}<br/>Mean β: ${isFinite(mean(bet))? mean(bet).toFixed(2)+'°' : 'n/a'} Max β: ${isFinite(maxv(bet))? maxv(bet).toFixed(2)+'°' : 'n/a'}<br/>Mean αf: ${isFinite(mean(af))? mean(af).toFixed(2)+'°' : 'n/a'} Mean αr: ${isFinite(mean(ar))? mean(ar).toFixed(2)+'°' : 'n/a'}`;
      const actions = document.createElement('div'); actions.style.display='flex'; actions.style.flexDirection='column'; actions.style.gap='6px'; const showBtn = document.createElement('button'); showBtn.textContent='Show on map'; showBtn.addEventListener('click', ()=>{ const sel = qs('#lapSelect'); if(sel){ sel.value = String(b.lap); state.showAllLaps = false; qs('#showAllLaps').checked = false; renderMap(); } });
      const exportBtn = document.createElement('button'); exportBtn.textContent='Export lap CSV'; exportBtn.addEventListener('click', ()=>{ exportLapCSV(b.lap); }); actions.appendChild(showBtn); actions.appendChild(exportBtn);
      card.appendChild(s); const col = document.createElement('div'); col.style.display='flex'; col.style.flexDirection='column'; col.style.gap='8px'; col.appendChild(info); col.appendChild(actions); card.appendChild(col);
      wrap.appendChild(card);
    }
  }

  // Export lap data as CSV for a lap index
  function exportLapCSV(lapIdx){ if(!state.lapBoundaries || !state.lapBoundaries[lapIdx]) return alert('No lap data'); const b = state.lapBoundaries[lapIdx]; const rows = ['time,vx,vy,beta,alpha_f,alpha_r']; for(let i=b.startIdx;i<=b.endIdx;i++){ const t = state.t[i]||0; const vx = isFinite(state.vx && state.vx[i])? state.vx[i] : ''; const vy = isFinite(state.vy_dynamic && state.vy_dynamic[i])? state.vy_dynamic[i] : (isFinite(state.vy_body && state.vy_body[i])? state.vy_body[i] : ''); const beta = isFinite(state.beta_basic && state.beta_basic[i])? (state.beta_basic[i]*180/Math.PI) : ''; const af = isFinite(state.alpha_f && state.alpha_f[i])? (state.alpha_f[i]*180/Math.PI) : ''; const ar = isFinite(state.alpha_r && state.alpha_r[i])? (state.alpha_r[i]*180/Math.PI) : ''; rows.push([t.toFixed(3), vx, vy, beta, af, ar].join(',')); } const blob = new Blob([rows.join('\n')], {type:'text/csv'}); const url = URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=`lap_${lapIdx+1}.csv`; a.click(); URL.revokeObjectURL(url); }

  // Attach interactive handlers for the raceline map (mouse over map -> show slip at that raceline point)
  function attachMapInteractions(){
    const map = qs('#map'); if(!map) return;
    // tooltip element
    const tooltip = qs('.tooltip') || document.createElement('div'); if(!qs('.tooltip')){ tooltip.className='tooltip'; tooltip.style.display='none'; document.body.appendChild(tooltip); }

    // remove previous handlers if present
    if(state._mapHandlers && state._mapHandlers.mousemove){ try{ map.removeEventListener('mousemove', state._mapHandlers.mousemove); }catch(e){} }
    if(state._mapHandlers && state._mapHandlers.click){ try{ map.removeEventListener('click', state._mapHandlers.click); }catch(e){} }
    if(state._mapHandlers && state._mapHandlers.leave){ try{ map.removeEventListener('mouseleave', state._mapHandlers.leave); }catch(e){} }

    // define handlers
    const onMouseMove = (ev)=>{
      try{
        // throttle mousemove processing to ~30-60Hz
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if(state._lastMapMove && (now - state._lastMapMove) < 33) return; state._lastMapMove = now;
        if(!state.mapProj || !state.ref || !state.refSvg) return;
        const pt = map.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY; const svgP = pt.matrixTransform(map.getScreenCTM().inverse()); const sx_mouse = svgP.x; const sy_mouse = svgP.y;
        let best=1e18, bi=-1; for(let j=0;j<state.refSvg.x.length;j++){ const dx = sx_mouse - state.refSvg.x[j]; const dy = sy_mouse - state.refSvg.y[j]; const d2 = dx*dx+dy*dy; if(d2<best){best=d2;bi=j;} }
        if(bi<0) return;
        const sel = qs('#lapSelect'); let selLap = 'all'; if(sel) selLap = sel.value || 'all';
        const preferredTime = (state.hoverIndex!=null && state.t)? state.t[state.hoverIndex] : null;
        const idxFromRef = pickSampleForRef(bi, { preferredTime, selectedLap: selLap, preferredIdx: state.hoverIndex });
        let tIdx = idxFromRef>=0? [idxFromRef] : [];
        let worldX = null, worldY = null; try{ const mp = state.mapProj || {}; const minx = mp.minx, maxx = mp.maxx, miny = mp.miny, maxy = mp.maxy, pad = mp.padding || 20, Wmap = mp.W || 800, Hmap = mp.H || 400, yShift = mp.yShift || 0; worldX = minx + ( (sx_mouse - pad) / (Wmap - 2*pad) ) * (maxx - minx); worldY = maxy - ( (sy_mouse - pad - yShift) / (Hmap - 2*pad) ) * (maxy - miny); }catch(e){}
        let idx = -1;
        if(tIdx.length>0){ idx = tIdx[0]; }
        else {
          // If a lap is selected, only search within that lap to avoid jumping to other laps
          const sel = qs('#lapSelect'); const selVal = sel? (sel.value||'all') : 'all';
          if(selVal !== 'all' && state.lapBoundaries && state.lapBoundaries.length){
            const L = parseInt(selVal);
            const b = state.lapBoundaries[L];
            if(b){ let best2=1e18, bi2=-1;
              if(isFinite(worldX) && isFinite(worldY)){
                for(let j=b.startIdx;j<=b.endIdx && j < state.x.length;j++){ if(!isFinite(state.x[j])||!isFinite(state.y[j])) continue; const dx = worldX - state.x[j]; const dy = worldY - state.y[j]; const d2 = dx*dx+dy*dy; if(d2<best2){best2=d2;bi2=j;} }
              }
              if(bi2>=0) idx = bi2; else idx = -1; // no candidate inside lap near this ref
            }
          } else {
            if(worldX==null || worldY==null){ idx = -1; } else { let best2=1e18, bi2=-1; for(let j=0;j<state.x.length;j++){ const dx = worldX - state.x[j]; const dy = worldY - state.y[j]; const d2 = dx*dx+dy*dy; if(d2<best2){best2=d2;bi2=j;} } idx = bi2; }
          }
        }
        const hm = qs('#hoverMarker'); if(hm && bi>=0 && state.refSvg){ const cx = state.refSvg.x[bi]; const cy = state.refSvg.y[bi]; hm.setAttribute('cx', cx); hm.setAttribute('cy', cy); hm.setAttribute('visibility','visible'); }
        if(idx < 0){ // no valid sample in selected lap — hide tooltip and do not update hoverIndex (prevents jumps)
          tooltip.style.display='none'; return;
        }
        const timeGlobal = (state.t && state.t[idx])? state.t[idx] : NaN;
        const time = timeGlobal; // keep absolute/global time (do not make lap-relative)
        const meas = (state.beta_basic && isFinite(state.beta_basic[idx])? (state.beta_basic[idx]*180/Math.PI).toFixed(2) : 'n/a');
        const pred = (state.beta_pred && isFinite(state.beta_pred[idx])? (state.beta_pred[idx]*180/Math.PI).toFixed(2) : 'n/a');
        const af = (state.alpha_f && isFinite(state.alpha_f[idx])? (state.alpha_f[idx]*180/Math.PI).toFixed(2) : 'n/a');
        const ar = (state.alpha_r && isFinite(state.alpha_r[idx])? (state.alpha_r[idx]*180/Math.PI).toFixed(2) : 'n/a');
        tooltip.style.display='block'; tooltip.style.left = (ev.clientX + 12) + 'px'; tooltip.style.top = (ev.clientY + 12) + 'px'; tooltip.innerHTML = `<strong>ref#=${bi}</strong><br/>t=${isFinite(time)?time.toFixed(2)+'s':'n/a'}<br/>Measured β: ${meas}°<br/>Predicted β: ${pred}°<br/>α_f: ${af}°<br/>α_r: ${ar}°`;
        state.hoverIndex = idx; renderSlipChart();
      }catch(err){ console.error('Map mousemove handler error', err); }
    };

    const onClick = (ev)=>{
      try{
        if(!state.startLineMode) return;
        if(!state.refSvg || !state.refSvg.x) { state.startLineMode = false; qs('#setStartBtn').textContent = 'Set Start Line'; return; }
        const pt = map.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY; const svgP = pt.matrixTransform(map.getScreenCTM().inverse()); const sx_mouse = svgP.x; const sy_mouse = svgP.y;
        let best = 1e18, bi = -1; for(let j=0;j<state.refSvg.x.length;j++){ const dx = sx_mouse - state.refSvg.x[j]; const dy = sy_mouse - state.refSvg.y[j]; const d2 = dx*dx+dy*dy; if(d2<best){ best=d2; bi=j; } }
        if(bi>=0){ const refIdx = (state.refSvg && state.refSvg.idx && state.refSvg.idx[bi] != null) ? state.refSvg.idx[bi] : bi; state.startRefIdx = refIdx; state.startLineMode = false; const btn = qs('#setStartBtn'); if(btn) btn.textContent = 'Set Start Line'; computeLapsFromStart(); renderMap(); }
      }catch(err){ console.error('Map click handler error', err); }
    };

    const onLeave = ()=>{ const tt = qs('.tooltip'); if(tt) tt.style.display='none'; const hm = qs('#hoverMarker'); if(hm) hm.setAttribute('visibility','hidden'); state.hoverIndex = null; renderSlipChart(); };

    // attach handlers and remember them for future clean-up
    map.addEventListener('mousemove', onMouseMove);
    map.addEventListener('click', onClick);
    map.addEventListener('mouseleave', onLeave);
    state._mapHandlers = { mousemove: onMouseMove, click: onClick, leave: onLeave };
    state._mapInteractionsAttached = true;
  }

  // When the selected lap changes, try to remap the current hover index to a sample
  // within the newly selected lap, preferring continuity in time/idx to avoid big jumps.
  function preserveHoverForSelection(){
    try{
      if(typeof state.hoverIndex !== 'number' || !state.t || !state.closestRefIndex) return;
      const prevIdx = state.hoverIndex;
      const prevTime = state.t[prevIdx];
      const refIdx = state.closestRefIndex[prevIdx];
      if(refIdx == null) return;
      const sel = qs('#lapSelect'); const selVal = sel? (sel.value||'all') : 'all';
      // ask pickSampleForRef to prefer the same time and the selected lap
      const newIdx = pickSampleForRef(refIdx, { preferredTime: prevTime, selectedLap: selVal, preferredIdx: prevIdx });
      if(newIdx != null && newIdx >= 0){ state.hoverIndex = newIdx; }
    }catch(e){ console.warn('preserveHoverForSelection failed', e); }
  }

  function renderDeviationChart(){
    const cvs = qs('#deviationChart'); const ctx = cvs.getContext('2d'); ctx.clearRect(0,0,cvs.width,cvs.height); if(!state.t || !state.cte) return;
    const W=cvs.width,H=cvs.height, left=40, top=10, right=20, bottom=20; const n=state.t.length;
    const tmin=state.t[0], tmax=state.t[n-1]; const thr = state.settings.devThresh||0.4;
    // scale
    const xs = state.t.map(v=> left + (v-tmin)/(tmax-tmin||1)*(W-left-right));
    const vals = state.cte.map(v=> v||0); const vmin=Math.min(...vals), vmax=Math.max(...vals);
    const ys = vals.map(v=> top + (1-( (v-vmin)/(vmax-vmin||1) ))*(H-top-bottom));
    ctx.strokeStyle='#9aa6b2'; ctx.lineWidth=1; ctx.beginPath(); for(let i=0;i<n;i++){ if(i===0) ctx.moveTo(xs[i],ys[i]); else ctx.lineTo(xs[i],ys[i]); } ctx.stroke();
    // threshold line
    const mapY = v=> top + (1-((v-vmin)/(vmax-vmin||1)))*(H-top-bottom);
    ctx.strokeStyle='rgba(255,77,79,0.8)'; ctx.beginPath(); ctx.moveTo(left,mapY(thr)); ctx.lineTo(W-right,mapY(thr)); ctx.stroke();
  }

  function renderSlipChart(){
    // If new grid canvases exist, render each small chart individually
    if(qs('#slipBeta')){
      renderSlipBeta(); renderSlipPred(); renderSlipVy(); renderSlipAlpha();
      return;
    }
    // Fallback: legacy single-canvas rendering (kept for compatibility)
    const cvs = qs('#slipChart'); if(!cvs) return; const ctx = cvs.getContext('2d'); ctx.clearRect(0,0,cvs.width,cvs.height); if(!state.t) return;
    const mode = document.querySelector('input[name=mode]:checked').value;
    const n=state.t.length; const left=40,top=10,right=20,bottom=20,W=cvs.width,H=cvs.height;
    const tmin=state.t[0], tmax=state.t[n-1]; const xs = state.t.map(v=> left + (v-tmin)/(tmax-tmin||1)*(W-left-right));
    let vals = (mode==='dynamic' && state.beta_dynamic)? state.beta_dynamic : state.beta_basic; if(!vals) return; vals = vals.map(v=> v*180/Math.PI);
    const pred = state.beta_pred? state.beta_pred.map(v=> isFinite(v)? v*180/Math.PI : NaN) : null;
    const alphaF = state.alpha_f? state.alpha_f.map(v=> isFinite(v)? v*180/Math.PI : NaN) : null;
    const alphaR = state.alpha_r? state.alpha_r.map(v=> isFinite(v)? v*180/Math.PI : NaN) : null;
    const combined = [].concat(vals.filter(v=>isFinite(v)), pred? pred.filter(v=>isFinite(v)):[], alphaF? alphaF.filter(v=>isFinite(v)):[], alphaR? alphaR.filter(v=>isFinite(v)):[]);
    if(combined.length===0) return;
    const vmin = Math.min(...combined), vmax = Math.max(...combined);
    const ys = vals.map(v=> isFinite(v)? top + (1-((v-vmin)/(vmax-vmin||1)))*(H-top-bottom) : NaN);
    ctx.strokeStyle='#ffcc00'; ctx.lineWidth=1.5; ctx.beginPath(); for(let i=0;i<n;i++){ if(!isFinite(ys[i])) continue; if(i===0 || !isFinite(ys[i-1])) ctx.moveTo(xs[i],ys[i]); else ctx.lineTo(xs[i],ys[i]); } ctx.stroke();
    const thr = state.settings.slipThresh||6; ctx.fillStyle='rgba(255,77,79,0.8)'; for(let i=0;i<n;i++){ if(isFinite(vals[i]) && Math.abs(vals[i])>thr){ ctx.fillRect(xs[i]-1, ys[i]-1, 3, 3); } }
    if(pred){ const ys_pred = pred.map(v=> isFinite(v)? top + (1-((v-vmin)/(vmax-vmin||1)))*(H-top-bottom) : NaN); ctx.strokeStyle='rgba(42,157,143,0.95)'; ctx.lineWidth=1.2; ctx.beginPath(); for(let i=0;i<n;i++){ if(!isFinite(ys_pred[i])) continue; if(i===0 || !isFinite(ys_pred[i-1])) ctx.moveTo(xs[i], ys_pred[i]); else ctx.lineTo(xs[i], ys_pred[i]); } ctx.stroke(); }
    if(alphaF){ const ys_af = alphaF.map(v=> isFinite(v)? top + (1-((v-vmin)/(vmax-vmin||1)))*(H-top-bottom) : NaN); ctx.strokeStyle='#ff6b6b'; ctx.lineWidth=1.0; ctx.beginPath(); for(let i=0;i<n;i++){ if(!isFinite(ys_af[i])) continue; if(i===0 || !isFinite(ys_af[i-1])) ctx.moveTo(xs[i], ys_af[i]); else ctx.lineTo(xs[i], ys_af[i]); } ctx.stroke(); }
    if(alphaR){ const ys_ar = alphaR.map(v=> isFinite(v)? top + (1-((v-vmin)/(vmax-vmin||1)))*(H-top-bottom) : NaN); ctx.strokeStyle='#4dabf7'; ctx.lineWidth=1.0; ctx.beginPath(); for(let i=0;i<n;i++){ if(!isFinite(ys_ar[i])) continue; if(i===0 || !isFinite(ys_ar[i-1])) ctx.moveTo(xs[i], ys_ar[i]); else ctx.lineTo(xs[i], ys_ar[i]); } ctx.stroke(); }
  }

  // Small-chart renderers for the slip grid (simple, uses global timeline)
  function renderSmallChart(canvas, series, opts={color:'#fff', fill:false, yLabel:''}){
    const cvs = qs('#'+canvas); if(!cvs) return; const ctx = cvs.getContext('2d'); ctx.clearRect(0,0,cvs.width,cvs.height);
    if(!state.t || !series) return; const n = state.t.length; if(n===0) return;
    const left=36, top=18, right=10, bottom=22, W=cvs.width, H=cvs.height;
    // use per-lap time axis when a lap is selected
    const lapSel = qs('#lapSelect')? (qs('#lapSelect').value || 'all') : 'all';
    let tarr = null;
    if(lapSel !== 'all' && state.lapBoundaries && state.lapBoundaries.length){ tarr = _buildLapTimeArray(); }
    const timeArray = (tarr && Array.isArray(tarr)) ? tarr : state.t;
    const tmin = timeArray[0], tmax = timeArray[timeArray.length-1]; const xs = timeArray.map(v=> isFinite(v)? left + (v-tmin)/(tmax-tmin||1)*(W-left-right) : NaN);
    const vals = series.map(v=> isFinite(v)? v : NaN);
    const fin = vals.filter(isFinite); if(fin.length===0) return;
    const vmin = Math.min(...fin), vmax = Math.max(...fin);
    const mapY = v=> top + (1-((v - vmin)/(vmax-vmin||1)))*(H-top-bottom);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
    const ticks = [vmax, (vmax+vmin)/2, vmin]; ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font='11px sans-serif';
    for(let i=0;i<ticks.length;i++){ const y = mapY(ticks[i]); ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(W-right, y); ctx.stroke(); ctx.fillText(ticks[i].toFixed(2), 6, y+4); }
    ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font='11px sans-serif'; ctx.fillText((isFinite(tmin)?tmin:0).toFixed(2)+'s', left, H-6); ctx.fillText((isFinite(tmax)?tmax:0).toFixed(2)+'s', W-right-50, H-6);
    ctx.strokeStyle = opts.color || '#fff'; ctx.lineWidth = 1.6; ctx.beginPath();
    for(let i=0;i<n;i++){ const v = vals[i]; if(!isFinite(v) || !isFinite(xs[i])) continue; const x = xs[i], y = mapY(v); if(i===0 || !isFinite(vals[i-1]) || !isFinite(xs[i-1])) ctx.moveTo(x,y); else ctx.lineTo(x,y); }
    ctx.stroke();
    if(typeof state.hoverIndex === 'number' && state.hoverIndex>=0 && state.hoverIndex < n){ const hi = state.hoverIndex; if(isFinite(xs[hi])){ const xv = xs[hi]; ctx.strokeStyle = 'rgba(255,210,100,0.9)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(xv, top); ctx.lineTo(xv, H-bottom); ctx.stroke(); const hv = vals[hi]; if(isFinite(hv)){ const yv = mapY(hv); ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(xv, yv, 4, 0, Math.PI*2); ctx.fill(); ctx.fillStyle = opts.color || '#fff'; ctx.beginPath(); ctx.arc(xv, yv, 3, 0, Math.PI*2); ctx.fill(); } } }
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font='12px sans-serif'; ctx.fillText(opts.yLabel || '', 8, 14);
  }

  // Return global timeline (continuous across laps)
  function _buildLapTimeArray(){ return state.t ? state.t.slice() : []; }

  function renderSlipBeta(){ const mode = document.querySelector('input[name=mode]:checked').value; const series = (mode==='dynamic' && state.beta_dynamic)? state.beta_dynamic.map(v=>v*180/Math.PI) : (state.beta_basic? state.beta_basic.map(v=>v*180/Math.PI) : null); renderSmallChart('slipBeta', series, {color:'#ffcc00', yLabel:'β (deg)'}); }
  function renderSlipPred(){ const series = state.beta_pred? state.beta_pred.map(v=> isFinite(v)? v*180/Math.PI : NaN) : null; renderSmallChart('slipPred', series, {color:'rgba(42,157,143,0.95)', yLabel:'β_pred (deg)'}); }
  function renderSlipVy(){ const series = state.vy_dynamic? state.vy_dynamic : state.vy_body? state.vy_body : null; renderSmallChart('slipVy', series, {color:'#ffd166', yLabel:'vy (m/s)'}); }
  function renderSlipAlpha(){ const af = state.alpha_f? state.alpha_f.map(v=> isFinite(v)? v*180/Math.PI : NaN) : null; const ar = state.alpha_r? state.alpha_r.map(v=> isFinite(v)? v*180/Math.PI : NaN) : null; // draw both on same canvas
    const cvsId = 'slipAlpha'; const cvs = qs('#'+cvsId); if(!cvs) return; const ctx = cvs.getContext('2d'); ctx.clearRect(0,0,cvs.width,cvs.height);
    if(!state.t) return; const n=state.t.length; const left=36, top=18, right=10, bottom=22, W=cvs.width, H=cvs.height; const tmin=state.t[0], tmax=state.t[n-1]; const xs = state.t.map(v=> left + (v-tmin)/(tmax-tmin||1)*(W-left-right));
    const comb = [].concat(af?af.filter(isFinite):[], ar?ar.filter(isFinite):[]); if(comb.length===0) return; const vmin=Math.min(...comb), vmax=Math.max(...comb); const mapY = v=> top + (1-((v-vmin)/(vmax-vmin||1)))*(H-top-bottom);
    if(af){ ctx.strokeStyle='#ff6b6b'; ctx.lineWidth=1.2; ctx.beginPath(); for(let i=0;i<n;i++){ if(!isFinite(af[i])) continue; const x=xs[i], y=mapY(af[i]); if(i===0||!isFinite(af[i-1])) ctx.moveTo(x,y); else ctx.lineTo(x,y); } ctx.stroke(); }
    if(ar){ ctx.strokeStyle='#4dabf7'; ctx.lineWidth=1.2; ctx.beginPath(); for(let i=0;i<n;i++){ if(!isFinite(ar[i])) continue; const x=xs[i], y=mapY(ar[i]); if(i===0||!isFinite(ar[i-1])) ctx.moveTo(x,y); else ctx.lineTo(x,y); } ctx.stroke(); }
    ctx.fillStyle='rgba(255,255,255,0.8)'; ctx.font='12px sans-serif'; ctx.fillText('α_f (red)', 8, 14); ctx.fillText('α_r (blue)', 90, 14);
    // hover vertical line and markers
    if(typeof state.hoverIndex === 'number' && state.hoverIndex>=0 && state.hoverIndex < n){ const hi = state.hoverIndex; const xv = xs[hi]; ctx.strokeStyle = 'rgba(255,210,100,0.9)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(xv, top); ctx.lineTo(xv, H-bottom); ctx.stroke(); if(af && isFinite(af[hi])){ const yfa = mapY(af[hi]); ctx.fillStyle='#000'; ctx.beginPath(); ctx.arc(xv, yfa, 4, 0, Math.PI*2); ctx.fill(); ctx.fillStyle='#ff6b6b'; ctx.beginPath(); ctx.arc(xv, yfa, 3, 0, Math.PI*2); ctx.fill(); } if(ar && isFinite(ar[hi])){ const yra = mapY(ar[hi]); ctx.fillStyle='#000'; ctx.beginPath(); ctx.arc(xv, yra, 4, 0, Math.PI*2); ctx.fill(); ctx.fillStyle='#4dabf7'; ctx.beginPath(); ctx.arc(xv, yra, 3, 0, Math.PI*2); ctx.fill(); } }
  }

  // nearest time index lookup using binary search on state.t
  function nearestTimeIndex(tArr, value){
    if(!tArr || tArr.length===0) return -1; let lo=0, hi=tArr.length-1; if(value<=tArr[0]) return 0; if(value>=tArr[hi]) return hi;
    while(lo<=hi){ const mid = Math.floor((lo+hi)/2); if(tArr[mid]===value) return mid; if(tArr[mid]<value) lo=mid+1; else hi=mid-1; }
    const i1 = Math.max(0, lo-1); const i2 = Math.min(tArr.length-1, lo); return (Math.abs(tArr[i1]-value) <= Math.abs(tArr[i2]-value))? i1 : i2;
  }

  // Choose the best sample index for a given reference index `refIdx`.
  // Preferences:
  // 1) samples within the currently selected lap (if any)
  // 2) candidate closest in time to `preferredTime` (usually previous hover time)
  // 3) candidate with smallest index distance to previous hover index
  // 4) fallback to median candidate
  function pickSampleForRef(refIdx, opts = {}){
    if(!state.closestRefIndex || !Array.isArray(state.closestRefIndex)) return -1;
    const preferredTime = (opts.preferredTime!=null)? opts.preferredTime : (state.hoverIndex!=null && state.t? state.t[state.hoverIndex] : null);
    const preferredIdx = (opts.preferredIdx!=null)? opts.preferredIdx : state.hoverIndex;
    const selLapVal = (opts.selectedLap!=null)? opts.selectedLap : (qs('#lapSelect')? qs('#lapSelect').value : 'all');
    // gather all samples that map to this refIdx (use cached map if available)
    let candidates = [];
    if(state.refToSamples && Array.isArray(state.refToSamples) && state.refToSamples[refIdx]){
      candidates = state.refToSamples[refIdx].slice();
    } else {
      for(let i=0;i<state.closestRefIndex.length;i++){ if(state.closestRefIndex[i] === refIdx) candidates.push(i); }
    }
    if(candidates.length===0) return -1;
    // If a lap selected, prefer candidates inside that lap. If none map to this ref,
    // fall back to the nearest-in-lap sample (spatial search) instead of picking another lap's sample.
    let filtered = candidates;
    if(selLapVal !== 'all' && state.lapNumbers){ const L = parseInt(selLapVal); const inLap = candidates.filter(i=> state.lapNumbers[i]===L); if(inLap.length>0){ filtered = inLap; }
      else {
        // attempt nearest-in-lap spatial lookup using lap boundaries if available
        if(state.lapBoundaries && state.lapBoundaries[L]){
          const b = state.lapBoundaries[L]; let bestd = Number.POSITIVE_INFINITY, besti = -1;
          // use reference world coordinate if available
          const rx = (state.ref && state.ref.x && isFinite(state.ref.x[refIdx]))? state.ref.x[refIdx] : null;
          const ry = (state.ref && state.ref.y && isFinite(state.ref.y[refIdx]))? state.ref.y[refIdx] : null;
          if(rx != null && ry != null){ for(let ii=b.startIdx; ii<=b.endIdx && ii<state.x.length; ii++){ if(!isFinite(state.x[ii])||!isFinite(state.y[ii])) continue; const dx = state.x[ii]-rx; const dy = state.y[ii]-ry; const d2 = dx*dx+dy*dy; if(d2 < bestd){ bestd = d2; besti = ii; } } }
          if(besti >= 0) return besti;
        }
        // otherwise leave filtered as full candidates (will be handled below)
      }
    }
    // If we have a preferred time, pick the candidate with minimum time difference
    if(isFinite(preferredTime) && preferredTime!=null){ let bestd=Number.POSITIVE_INFINITY, bestIdx=-1; for(const ci of filtered){ const dt = Math.abs((state.t[ci]||0) - preferredTime); if(dt < bestd){ bestd = dt; bestIdx = ci; }} if(bestIdx >= 0){ // additional safety: avoid huge jumps (>6s) unless no other candidate closer by index
        if(bestd > 6 && preferredIdx!=null){ // try index proximity fallback
          let besti = -1, bestIdxDist = Number.POSITIVE_INFINITY; for(const ci of filtered){ const dIdx = Math.abs(ci - preferredIdx); if(dIdx < bestIdxDist){ bestIdxDist = dIdx; besti = ci; } }
          if(besti >= 0) return besti;
        }
        return bestIdx;
      }
    }
    // If preferred index is within filtered, keep it for continuity
    if(preferredIdx!=null && filtered.indexOf(preferredIdx) >= 0) return preferredIdx;
    // Otherwise pick candidate with smallest index distance to previous hover index
    if(preferredIdx!=null){ let besti=-1, bestd=Number.POSITIVE_INFINITY; for(const ci of filtered){ const d = Math.abs(ci - preferredIdx); if(d < bestd){ bestd = d; besti = ci; } } if(besti>=0) return besti; }
    // fallback to median candidate
    return filtered[Math.floor(filtered.length/2)];
  }

  // show corner overlay with stats (simple diagnostics panel)
  function showCornerOverlay(cinfo){
    const existing = qs('#diagOverlay'); if(existing) existing.remove(); const o = document.createElement('div'); o.id='diagOverlay'; o.style.zIndex=99999; o.style.left='10%'; o.style.top='20%'; o.style.width='40%'; o.style.height='auto'; o.style.background='rgba(2,6,10,0.95)'; o.style.padding='12px'; o.style.border='1px solid rgba(255,255,255,0.06)'; o.style.borderRadius='8px';
    const close = document.createElement('button'); close.id='diagClose'; close.textContent='Close'; close.addEventListener('click',()=>o.remove()); o.appendChild(close);
    const h = document.createElement('h3'); h.textContent = `Corner ${state.corners.indexOf(cinfo)+1}`; o.appendChild(h);
    const body = document.createElement('div'); body.innerHTML = `<div>Samples: ${cinfo.count}</div><div>Mean measured beta: ${isFinite(cinfo.meanBeta)? cinfo.meanBeta.toFixed(2)+'°' : 'n/a'}</div><div>Max measured beta: ${isFinite(cinfo.maxBeta)? cinfo.maxBeta.toFixed(2)+'°' : 'n/a'}</div><div>Mean predicted beta: ${isFinite(cinfo.meanBetaPred)? cinfo.meanBetaPred.toFixed(2)+'°' : 'n/a'}</div><div>Mean alpha_f: ${isFinite(cinfo.meanAlphaF)? cinfo.meanAlphaF.toFixed(2)+'°' : 'n/a'}</div><div>Mean alpha_r: ${isFinite(cinfo.meanAlphaR)? cinfo.meanAlphaR.toFixed(2)+'°' : 'n/a'}</div>`;
    o.appendChild(body); document.body.appendChild(o);
  }

  // Attach interactive hover handlers for slip chart (show values and update map hover marker)
  function getHoverHTML(idx){
    if(!state.t || idx<0 || idx>=state.t.length) return '';
    // show lap-relative time when a lap is selected
    let timeLabel = state.t[idx];
    try{
      // Always show absolute/global time — do not reset per-lap.
      timeLabel = state.t[idx].toFixed(3) + 's';
    }catch(e){ timeLabel = state.t[idx].toFixed(3) + 's'; }
    const vx = state.vx? state.vx[idx] : (state.vx_body? state.vx_body[idx] : NaN);
    const vy = state.vy_body? state.vy_body[idx] : NaN;
    const beta = state.beta_basic? (state.beta_basic[idx]*180/Math.PI).toFixed(2) : '';
    return `<div><b>t:</b> ${timeLabel}<br/><b>vx:</b> ${isFinite(vx)?vx.toFixed(2):'N/A'} m/s<br/><b>vy:</b> ${isFinite(vy)?vy.toFixed(2):'N/A'} m/s<br/><b>β:</b> ${beta}°</div>`;
  }

  function attachSlipInteractions(){
    if(state._slipInteractionsAttached) return; state._slipInteractionsAttached = true;
    let tooltip = qs('.tooltip'); if(!tooltip){ tooltip = document.createElement('div'); tooltip.className='tooltip'; tooltip.style.display='none'; document.body.appendChild(tooltip); }
    const canvasIds = ['slipBeta','slipPred','slipVy','slipAlpha'];
    for(const id of canvasIds){
      const cvs = qs('#'+id); if(!cvs) continue;
      cvs.addEventListener('mousemove', ev=>{
        if(!state.t || state.t.length===0) return;
        const rect = cvs.getBoundingClientRect(); const xCanvas = (ev.clientX - rect.left) * (cvs.width / rect.width);
        const left = 36, right = 10;
        // If a lap is selected, map canvas x->lap-relative time and restrict to that lap's indices
        const sel = qs('#lapSelect'); const selVal = sel? (sel.value||'all') : 'all';
        let idx = -1;
        if(selVal !== 'all' && state.lapBoundaries && state.lapBoundaries.length){
          const tarr = _buildLapTimeArray(); const visibleIdx = [], visibleTimes = [];
          for(let i=0;i<tarr.length;i++){ if(isFinite(tarr[i])){ visibleIdx.push(i); visibleTimes.push(tarr[i]); } }
          if(visibleTimes.length>0){ const tmin = visibleTimes[0], tmax = visibleTimes[visibleTimes.length-1]; const tx = (xCanvas - left) / (cvs.width - left - right); const tval = tmin + tx * (tmax - tmin);
            const rel = nearestTimeIndex(visibleTimes, tval);
            if(rel >= 0) idx = visibleIdx[rel];
            // prefer continuity: if previous hover is in same lap and present, use it
            if(typeof state.hoverIndex === 'number' && state.hoverIndex >=0 && state.lapNumbers && state.lapNumbers[state.hoverIndex] == parseInt(selVal) && visibleIdx.indexOf(state.hoverIndex) >= 0){ idx = state.hoverIndex; }
          }
        }
        // fallback to global timeline mapping
        if(idx < 0){ const tminG = state.t[0], tmaxG = state.t[state.t.length-1]; const txg = (xCanvas - left) / (cvs.width - left - right); const tvalG = tminG + txg * (tmaxG - tminG); idx = nearestTimeIndex(state.t, tvalG); }
        if(idx<0) return; state.hoverIndex = idx;
        tooltip.style.display='block'; tooltip.style.left = (ev.clientX + 12) + 'px'; tooltip.style.top = (ev.clientY + 12) + 'px'; tooltip.innerHTML = getHoverHTML(idx);
        const map = qs('#map'); if(map && state.closestRefIndex && state.ref){ const refIdx = state.closestRefIndex[idx]; if(refIdx!=null && state.refSvg && state.refSvg.x && state.refSvg.x[refIdx]){ const hm = qs('#hoverMarker'); if(hm){ hm.setAttribute('cx', state.refSvg.x[refIdx]); hm.setAttribute('cy', state.refSvg.y[refIdx]); hm.setAttribute('visibility','visible'); } } }
        renderSlipChart();
      });
      cvs.addEventListener('mouseleave', ev=>{ state.hoverIndex = null; const tt = qs('.tooltip'); if(tt) tt.style.display='none'; const hm = qs('#hoverMarker'); if(hm) hm.setAttribute('visibility','hidden'); renderSlipChart(); });
    }
  }

  function renderTireFit(){
    const cvs = qs('#tireFit'); const ctx = cvs.getContext('2d'); ctx.clearRect(0,0,cvs.width,cvs.height);
    if(!state.tireFit || !state.beta_basic || !state.Fy) { qs('#tireReport').textContent = 'Insufficient data for tire fit.'; return; }
    const a = state.tireFit.a, b = state.tireFit.b; qs('#tireReport').textContent = `Fit: Fy = ${a.toFixed(1)}*beta + ${b.toFixed(1)}*beta^3  R2=${(state.tireFit.r2||0).toFixed(2)}`;
    // scatter
    const bet = state.beta_basic.map(b=>b*180/Math.PI); const Fy = state.Fy; const pts = []; for(let i=0;i<bet.length;i++) if(isFinite(bet[i]) && isFinite(Fy[i])) pts.push({x:bet[i],y:Fy[i]});
    if(pts.length===0) return; const xs=pts.map(p=>p.x), ys=pts.map(p=>p.y); const minx=Math.min(...xs),maxx=Math.max(...xs),miny=Math.min(...ys),maxy=Math.max(...ys);
    const W=cvs.width,H=cvs.height,left=40,top=10,right=20,bottom=30;
    const sx=v=> left + (v-minx)/(maxx-minx||1)*(W-left-right); const sy=v=> top + (1-((v-miny)/(maxy-miny||1)))*(H-top-bottom);
    ctx.fillStyle='#9aa6b2'; for(const p of pts){ctx.fillRect(sx(p.x)-2,sy(p.y)-2,4,4);}    
    // model curve
    ctx.strokeStyle='#2a9d8f'; ctx.beginPath(); for(let t=-1;t<=1;t+=0.01){const beta = minx + (t+1)/2*(maxx-minx||1); const pred = a*(beta*Math.PI/180)+b*Math.pow(beta*Math.PI/180,3); const xx=sx(beta), yy=sy(pred); if(t===-1) ctx.moveTo(xx,yy); else ctx.lineTo(xx,yy);} ctx.stroke();
  }

  function renderGPS(){
    const cvs = qs('#gpsChart'); const ctx = cvs.getContext('2d'); ctx.clearRect(0,0,cvs.width,cvs.height); if(!state.t) return;
    const n=state.t.length; const W=cvs.width,H=cvs.height,left=40,top=10,right=20,bottom=20; const tmin=state.t[0],tmax=state.t[n-1]; const xs = state.t.map(v=> left + (v-tmin)/(tmax-tmin||1)*(W-left-right));
    // plot dt between samples
    const dts = state.t.map((v,i)=> i===0?0: v-state.t[i-1]); const vmax=Math.max(...dts); const ys = dts.map(d=> top + (1-d/(vmax||1))*(H-top-bottom)); ctx.strokeStyle='#9aa6b2'; ctx.beginPath(); for(let i=0;i<n;i++){ if(i===0) ctx.moveTo(xs[i],ys[i]); else ctx.lineTo(xs[i],ys[i]); } ctx.stroke();
    // mark drop zones
    ctx.fillStyle='rgba(255,77,79,0.12)'; for(const z of state.gps_drop_zones){const x1= left + (z.start-tmin)/(tmax-tmin||1)*(W-left-right); const x2= left + (z.end-tmin)/(tmax-tmin||1)*(W-left-right); ctx.fillRect(x1,top,x2-x1,H-top-bottom);}    
    qs('#gpsReport').textContent = `Detected ${state.gps_drop_zones.length} GPS dropout zones.`;
  }

  function renderControllerStatus(){
    const el = qs('#controllerStatus'); el.innerHTML=''; if(!state.data){el.textContent='No dataset loaded.';return}
    const needed = ['heading','vx','yaw_rate']; const have = needed.map(k=>!!state.mapping[k]); const missing = needed.filter((k,i)=>!have[i]);
    const score = 100 - missing.length*30 - (state.gps_drop_zones.length*5);
    el.innerHTML = `<div>State completeness score: ${score}</div><div>Missing signals: ${missing.join(', ') || 'none'}</div>`;
  }

  // Exports
  function exportJSON(){
    const out = {metrics:state.metrics, settings:state.settings, gpsDrops:state.gps_drop_zones, mapping:state.mapping};
    const blob = new Blob([JSON.stringify(out,null,2)],{type:'application/json'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='diagnostic_report.json'; a.click(); URL.revokeObjectURL(url);
  }

  function exportPNG(){
    const slip = qs('#slipChart'); try{ const url = slip.toDataURL('image/png'); const w=window.open(); w.document.body.innerHTML=`<img src="${url}"/>`; }catch(e){alert('PNG export failed: '+e.message)}
  }

  // Load embedded sample CSV
  function loadSample(){
    const sample = `time,lat,lon,heading,yaw_rate,speed,steering,ax,ay
0,37.2321,-121.020,0,0,0,0,0,0
0.1,37.23211,-121.02001,0.01,0.1,1.2,0.02,0.01,0.05
0.2,37.23213,-121.02003,0.02,0.11,2.1,0.03,0.02,0.15
0.3,37.23217,-121.02006,0.03,0.12,3.0,0.02,0.03,0.25
0.4,37.23223,-121.02012,0.05,0.14,3.5,0.01,0.01,0.30
0.5,37.23231,-121.02020,0.08,0.18,4.0,0,0.0,0.4
`;
    processCSV(sample);
    qs('#dataset').textContent = 'sample.csv';
  }

  // Progress helpers
  function showProgress(pct, text){
    const wrap = qs('#progressBar'); const label = qs('#progressLabel'); if(!wrap) return; wrap.style.width = Math.max(0,Math.min(100,pct)) + '%'; if(label) label.textContent = text||''; qs('#progressWrap').style.display='flex';
  }
  function hideProgress(){ qs('#progressWrap').style.display='none'; qs('#progressBar').style.width='0%'; qs('#progressLabel').textContent=''; }

  // start
  init();
})();
