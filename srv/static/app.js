(() => {
  'use strict';
  const MIN_PX = 16;
  const PREFERRED_PX = 21;
  const MANUAL_MIN_PX = 12;
  const MANUAL_MAX_PX = 32;
  let refitTimer;
  let activeLivePanel = null;

  function detectFormFactor() {
    const ua = navigator.userAgent;
    if (/iPhone|iPod/i.test(ua)) return 'phone';
    const ipad = /iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ipad || (navigator.maxTouchPoints > 0 && (window.visualViewport?.width || innerWidth) >= 768)) return 'tablet';
    return (window.visualViewport?.width || innerWidth) < 768 ? 'phone' : 'tablet';
  }

  function setFormFactor() {
    document.documentElement.dataset.formFactor = detectFormFactor();
  }

  function setupFlashMessage() {
    let message='';
    try { message=sessionStorage.getItem('songs-flash-warning')||''; sessionStorage.removeItem('songs-flash-warning'); } catch {}
    if(!message)return;
    const notice=document.createElement('div');
    notice.className='flash-warning'; notice.setAttribute('role','alert'); notice.textContent=message;
    document.body.append(notice);
    setTimeout(()=>notice.remove(),12000);
  }

  function expandFlowNodes(source) {
    const expanded = [];
    for (const node of source.childNodes) {
      if (node.nodeType === Node.COMMENT_NODE && node.nodeValue.trim().toLowerCase() === 'column-break') {
        const marker=document.createElement('span');
        marker.__songsColumnBreak=true; marker.hidden=true; expanded.push(marker);
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || node.tagName === 'H1') continue;
      if (node.tagName !== 'P' || node.querySelectorAll('br').length < 10) {
        expanded.push(node);
        continue;
      }
      let paragraph = document.createElement('p');
      let breaks = 0;
      for (const child of [...node.childNodes]) {
        paragraph.append(child.cloneNode(true));
        if (child.nodeName === 'BR') breaks++;
        if (breaks >= 8) {
          expanded.push(paragraph);
          paragraph = document.createElement('p');
          breaks = 0;
        }
      }
      if (paragraph.childNodes.length) expanded.push(paragraph);
    }
    return expanded;
  }

  function cloneSectionHeading(node) {
    const heading = node.cloneNode(false);
    const text = node.textContent.trim();
    const measure = /\b\d+\s*[xX](?:\s*\+\s*\d+)?\b/g;
    let cursor = 0;
    for (const match of text.matchAll(measure)) {
      heading.append(document.createTextNode(text.slice(cursor, match.index)));
      const count = document.createElement('span');
      count.className = 'measure-count';
      count.textContent = match[0].replace(/\s*[xX]\s*/, 'x').replace(/\s*\+\s*/, '+');
      heading.append(count);
      cursor = match.index + match[0].length;
    }
    heading.append(document.createTextNode(text.slice(cursor)));
    return heading;
  }

  function isColumnBreak(node) {
    return node?.__songsColumnBreak === true;
  }

  function sectionize(source) {
    const nodes = expandFlowNodes(source);
    const sections = [];
    let headingGroup = null;
    const push = section => {
      section.dataset.sectionIndex = String(sections.length);
      sections.push(section);
    };
    for (const node of nodes) {
      if (isColumnBreak(node)) {
        if (headingGroup) { push(headingGroup); headingGroup=null; }
        push(node);
        continue;
      }
      if (/^H[23]$/.test(node.tagName)) {
        if (headingGroup) push(headingGroup);
        headingGroup = document.createElement('section');
        headingGroup.className = 'section-block';
        headingGroup.append(cloneSectionHeading(node));
        continue;
      }
      if (headingGroup) {
        headingGroup.append(node.cloneNode(true));
        push(headingGroup);
        headingGroup = null;
        continue;
      }
      const section = document.createElement('section');
      section.className = 'section-block';
      section.append(node.cloneNode(true));
      push(section);
    }
    if (headingGroup) push(headingGroup);
    return sections.length ? sections : [Object.assign(document.createElement('section'), {className:'section-block'})];
  }

  function makeColumn() {
    const col = document.createElement('div');
    col.className = 'live-column';
    return col;
  }

  function applyTypography(panel, px, line) {
    panel.style.setProperty('--sheet-font', `${px}px`);
    panel.style.setProperty('--sheet-line', String(line));
  }

  function songIDForPanel(panel) {
    return panel?.dataset.songId || panel?.closest('[data-live-panel][data-song-id]')?.dataset.songId || '';
  }

  function storedFontSize(panel) {
    const id = songIDForPanel(panel);
    const value = id ? Number(localStorage.getItem(`songs-font-size:${id}`)) : NaN;
    return Number.isFinite(value) && value >= MANUAL_MIN_PX && value <= MANUAL_MAX_PX ? value : 0;
  }

  function finalizeTypography(panel, autoPx, line) {
    panel.dataset.autoBodyPx = String(autoPx);
    panel.dataset.lineHeight = String(line);
    const manualPx = storedFontSize(panel);
    const px = manualPx || autoPx;
    applyTypography(panel, px, line);
    panel.dataset.bodyPx = String(px);
    if (manualPx) panel.dataset.manualFont = 'true'; else delete panel.dataset.manualFont;
    refreshFontControls();
    if (manualPx) updateManualFitStatus(panel);
  }

  function measureSections(sections, width, panel, px, line) {
    const host = document.createElement('div');
    host.className = 'measure-host live-columns';
    host.style.display = 'block';
    host.style.width = `${Math.max(1, width)}px`;
    host.style.height = 'auto';
    applyTypography(host, px, line);
    for (const section of sections) host.append(section.cloneNode(true));
    panel.append(host);
    const heights = [...host.children].map(el => Math.ceil(el.getBoundingClientRect().height));
    host.remove();
    return heights;
  }

  function bestSplit(heights) {
    if (heights.length <= 1) return 1;
    const total = heights.reduce((a,b) => a+b, 0);
    let sum = 0, best = 1, delta = Infinity;
    for (let i=1; i<heights.length; i++) {
      sum += heights[i-1];
      const d = Math.abs(sum - (total-sum));
      if (d < delta) { delta=d; best=i; }
    }
    return best;
  }

  function forcedColumnSplit(sections) {
    for(let split=1;split<sections.length-1;split++) {
      if(isColumnBreak(sections[split]) && sections.slice(0,split).some(section=>!isColumnBreak(section)) && sections.slice(split+1).some(section=>!isColumnBreak(section))) return split;
    }
    return 0;
  }

  function renderColumns(container, sections, count, split) {
    container.replaceChildren();
    if (count === 1) {
      const col = makeColumn();
      sections.filter(section=>!isColumnBreak(section)).forEach(s => col.append(s.cloneNode(true)));
      container.append(col);
      return [col];
    }
    const left = makeColumn(), right = makeColumn();
    sections.forEach((s,i) => { if(!isColumnBreak(s)) (i < split ? left : right).append(s.cloneNode(true)); });
    container.append(left,right);
    return [left,right];
  }

  function horizontalSafe(el) { return el.scrollWidth <= el.clientWidth + 1; }

  async function fitSheet(panel) {
    const source = panel.querySelector('[data-apex-source]');
    const viewport = panel.querySelector('[data-sheet-viewport]');
    const container = panel.querySelector('[data-live-columns]');
    if (!source || !viewport || !container) return;
    const sections = sectionize(source);
    const form = document.documentElement.dataset.formFactor || detectFormFactor();
    await (document.fonts?.ready || Promise.resolve());

    if (form === 'phone') {
      applyTypography(panel, 20, 1.24);
      const [col] = renderColumns(container, sections, 1, sections.length);
      const safe = horizontalSafe(col) && horizontalSafe(container);
      panel.dataset.fitStatus = safe ? 'scrollable' : 'needs-editing';
      panel.dataset.columnCount = '1';
      finalizeTypography(panel,20,1.24);
      return;
    }

    const gap = parseFloat(getComputedStyle(container).columnGap || getComputedStyle(container).gap) || 24;
    const width = (viewport.clientWidth-gap)/2;
    const height = viewport.clientHeight;
    const forcedSplit = forcedColumnSplit(sections);
    let bestFailure = null;
    for (let px=PREFERRED_PX; px>=MIN_PX; px--) {
      for (const line of [1.24,1.20,1.16,1.12]) {
        applyTypography(panel, px, line);
        const heights = measureSections(sections,width,panel,px,line);
        const split = forcedSplit || bestSplit(heights);
        const leftHeight = heights.slice(0,split).reduce((a,b)=>a+b,0);
        const rightHeight = heights.slice(split).reduce((a,b)=>a+b,0);
        const columns = renderColumns(container,sections,2,split);
        const fits = leftHeight <= height+1 && rightHeight <= height+1 && columns.every(horizontalSafe) && horizontalSafe(container);
        if (fits) {
          panel.dataset.fitStatus='fit'; panel.dataset.columnCount='2';
          finalizeTypography(panel,px,line);
          return;
        }
        const overflow=Math.max(0,leftHeight-height,rightHeight-height);
        if (!bestFailure || overflow<bestFailure.overflow) bestFailure={px,line,split,overflow};
      }
    }
    const fail=bestFailure || {px:MIN_PX,line:1.12,split:forcedSplit || Math.ceil(sections.length/2),overflow:0};
    applyTypography(panel,MIN_PX,1.12); renderColumns(container,sections,2,fail.split);
    panel.dataset.fitStatus='needs-editing'; panel.dataset.columnCount='2';
    finalizeTypography(panel,MIN_PX,1.12);
  }

  function applySetTypography(panel,px,pad) {
    panel.style.setProperty('--set-font',`${px}px`);
    panel.style.setProperty('--set-row-pad',`${pad}px`);
    panel.dataset.bodyPx=String(px);
  }

  async function fitSetSheet(panel) {
    const viewport=panel.querySelector('[data-set-viewport]'),list=panel.querySelector('[data-set-entries]');
    if(!viewport||!list)return;
    await (document.fonts?.ready||Promise.resolve());
    const entries=[...list.querySelectorAll('.set-entry')],form=document.documentElement.dataset.formFactor||detectFormFactor();
    if(form==='phone') {
      panel.style.setProperty('--set-rows',String(Math.max(1,entries.length)));
      panel.dataset.columnCount='1'; applySetTypography(panel,16,3); panel.dataset.fitStatus='scrollable'; return;
    }
    const columns=entries.length>24&&viewport.clientWidth>=820?3:entries.length>12&&viewport.clientWidth>=600?2:1;
    panel.style.setProperty('--set-rows',String(Math.max(1,Math.ceil(entries.length/columns))));
    panel.dataset.columnCount=String(columns);
    for(let px=19;px>=11;px--) {
      const pad=px>=17?5:px>=14?4:2;
      applySetTypography(panel,px,pad);
      if(list.scrollHeight<=viewport.clientHeight+1&&list.scrollWidth<=viewport.clientWidth+1) {
        panel.dataset.fitStatus='fit'; return;
      }
    }
    panel.dataset.fitStatus='needs-editing';
  }

  async function fitAll() {
    for (const panel of document.querySelectorAll('[data-lead-sheet]')) await fitSheet(panel);
    for (const panel of document.querySelectorAll('[data-set-sheet]')) await fitSetSheet(panel);
    refreshFontControls();
  }
  function scheduleFit() { clearTimeout(refitTimer); refitTimer=setTimeout(()=>fitAll(),100); }

  function setupTheme() {
    const media = matchMedia('(prefers-color-scheme: light)');
    const stored = localStorage.getItem('songs-theme');
    if (stored === 'light' || stored === 'dark') document.documentElement.dataset.theme = stored;
    else document.documentElement.removeAttribute('data-theme');
    const effective = () => document.documentElement.dataset.theme || (media.matches ? 'light' : 'dark');
    const update = () => document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      const target = effective() === 'dark' ? 'light' : 'dark';
      const icon = button.querySelector('[aria-hidden="true"]');
      if (icon) icon.textContent = target === 'light' ? '☀︎' : '☾';
      button.setAttribute('aria-label', `Switch to ${target} mode`);
      button.setAttribute('title', `Switch to ${target} mode`);
    });
    update();
    media.addEventListener?.('change', () => { if (!document.documentElement.dataset.theme) { update(); scheduleFit(); } });
    document.querySelectorAll('[data-theme-toggle]').forEach(button => button.addEventListener('click', () => {
      const next = effective() === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('songs-theme', next);
      update();
      scheduleFit();
    }));
  }

  function setupSearch() {
    const input=document.querySelector('#song-search'); if(!input)return;
    const rows=[...document.querySelectorAll('.song-row')], count=document.querySelector('#song-count'), empty=document.querySelector('#no-results');
    const addMissing=document.querySelector('[data-add-missing-song]');
    const addSong=document.querySelector('[data-add-song]');
    const update=()=>{
      const raw=input.value.trim();
      const q=raw.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'');
      let shown=0;
      rows.forEach(row=>{
        const hay=row.dataset.search.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'');
        const match=!q||hay.includes(q);
        row.hidden=!match;
        if(match)shown++;
      });
      if(count) count.textContent=`${shown} songs`;
      if(empty) empty.hidden=!raw||shown!==0;
      const target='/songs/new'+(raw?`?title=${encodeURIComponent(raw)}`:'');
      if(addMissing){addMissing.href=target;addMissing.textContent=raw?`Add “${raw}”`:'Add this Song';}
      if(addSong) addSong.href=target;
    };
    input.addEventListener('input',update);
    input.addEventListener('keydown',event=>{
      if(event.key==='Escape'){input.value='';update();input.focus();}
      if(event.key==='Enter'){
        const visible=rows.filter(row=>!row.hidden);
        if(visible.length===1){event.preventDefault();location.href=visible[0].href;}
      }
    });
    addEventListener('keydown',event=>{if(event.key==='/'&&!/INPUT|TEXTAREA/.test(document.activeElement?.tagName)){event.preventDefault();input.focus();}});
    update();
  }

  function setupSetSorting() {
    const list=document.querySelector('[data-set-list]'),sort=document.querySelector('[data-set-sort]'),order=document.querySelector('[data-set-order]');
    if(!list||!sort||!order)return;
    try {
      if(['date','title'].includes(localStorage.getItem('songs-set-sort')))sort.value=localStorage.getItem('songs-set-sort');
      if(['asc','desc'].includes(localStorage.getItem('songs-set-order')))order.value=localStorage.getItem('songs-set-order');
    } catch {}
    const collator=new Intl.Collator(undefined,{sensitivity:'base',numeric:true});
    const update=()=>{
      const rows=[...list.querySelectorAll('.set-row')],field=sort.value,direction=order.value==='asc'?1:-1;
      rows.sort((a,b)=>{
        const av=(field==='date'?a.dataset.setDate:a.dataset.setTitle)||'',bv=(field==='date'?b.dataset.setDate:b.dataset.setTitle)||'';
        if(!av||!bv)return av? -1 : bv? 1 : 0;
        return collator.compare(av,bv)*direction;
      });
      rows.forEach(row=>list.append(row));
      try { localStorage.setItem('songs-set-sort',field); localStorage.setItem('songs-set-order',order.value); } catch {}
    };
    sort.addEventListener('change',update); order.addEventListener('change',update); update();
  }

  function currentVisibleLeadSheet() {
    const direct = document.querySelector('.lead-sheet-panel[data-song-id]');
    if (direct) return direct;
    if (activeLivePanel?.isConnected) return activeLivePanel.querySelector('[data-lead-sheet]');
    const panels = [...document.querySelectorAll('[data-live-panel][data-song-id]')];
    if (!panels.length) return null;
    const middle = innerHeight / 2;
    panels.sort((a,b)=>Math.abs(a.getBoundingClientRect().top+a.offsetHeight/2-middle)-Math.abs(b.getBoundingClientRect().top+b.offsetHeight/2-middle));
    return panels[0].querySelector('[data-lead-sheet]');
  }

  function currentVisibleSongID() {
    return songIDForPanel(currentVisibleLeadSheet());
  }

  function updateManualFitStatus(panel) {
    requestAnimationFrame(()=>{
      const container=panel?.querySelector('[data-live-columns]');
      const viewport=panel?.querySelector('[data-sheet-viewport]');
      if (!container || !viewport) return;
      const columns=[...container.querySelectorAll('.live-column')];
      const horizontal=columns.every(horizontalSafe) && horizontalSafe(container);
      if ((document.documentElement.dataset.formFactor || detectFormFactor()) === 'phone') {
        panel.dataset.fitStatus=horizontal?'scrollable':'needs-editing';
      } else {
        const vertical=columns.every(column=>column.scrollHeight<=viewport.clientHeight+1);
        panel.dataset.fitStatus=horizontal&&vertical?'fit':'needs-editing';
      }
    });
  }

  function refreshFontControls() {
    const panel=currentVisibleLeadSheet();
    const px=Number(panel?.dataset.bodyPx || PREFERRED_PX);
    document.querySelectorAll('[data-font-controls]').forEach(controls=>{
      const output=controls.querySelector('[data-font-size]');
      const decrease=controls.querySelector('[data-font-decrease]');
      const increase=controls.querySelector('[data-font-increase]');
      const reset=controls.querySelector('[data-font-reset]');
      if (output) output.textContent=String(px);
      if (decrease) decrease.disabled=!panel||px<=MANUAL_MIN_PX;
      if (increase) increase.disabled=!panel||px>=MANUAL_MAX_PX;
      if (reset) {
        reset.disabled=!panel||!panel.dataset.manualFont;
        reset.title=panel?.dataset.manualFont?`Return to auto-fit (${panel.dataset.autoBodyPx}px)`:'Using auto-fit';
      }
    });
  }

  function setupFontControls() {
    const controls=[...document.querySelectorAll('[data-font-controls]')];
    if (!controls.length) return;
    const change=delta=>{
      const panel=currentVisibleLeadSheet();
      if (!panel) return;
      const px=Math.max(MANUAL_MIN_PX,Math.min(MANUAL_MAX_PX,Number(panel.dataset.bodyPx||PREFERRED_PX)+delta));
      const line=Number(panel.dataset.lineHeight||1.2);
      const id=songIDForPanel(panel);
      applyTypography(panel,px,line); panel.dataset.bodyPx=String(px); panel.dataset.manualFont='true';
      if (id) localStorage.setItem(`songs-font-size:${id}`,String(px));
      updateManualFitStatus(panel); refreshFontControls();
    };
    controls.forEach(group=>{
      group.querySelector('[data-font-decrease]')?.addEventListener('click',()=>change(-1));
      group.querySelector('[data-font-increase]')?.addEventListener('click',()=>change(1));
      group.querySelector('[data-font-reset]')?.addEventListener('click',async()=>{
        const panel=currentVisibleLeadSheet();
        if (!panel) return;
        const id=songIDForPanel(panel); if (id) localStorage.removeItem(`songs-font-size:${id}`);
        delete panel.dataset.manualFont; await fitSheet(panel); refreshFontControls();
      });
    });
    refreshFontControls();
  }

  function setupShelleyEditor() {
    const triggers = [...document.querySelectorAll('[data-shelley-edit]')];
    if (!triggers.length || !('HTMLDialogElement' in window)) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'shelley-dialog';
    dialog.innerHTML = `<form method="dialog"><header><div><p class="eyebrow">Focused edit</p><h2>Ask Shelley</h2></div><button class="dialog-close" type="button" aria-label="Close">×</button></header><label><span>What should change?</span><textarea name="prompt" required maxlength="2000" placeholder="Verse 3 is actually 14 bars"></textarea></label><p class="dialog-help">Shelley will update the canonical Markdown, validate it, commit the change, and leave this page open while it works.</p><p class="shelley-job-status" data-shelley-status aria-live="polite"></p><div class="dialog-actions"><button class="button" type="button" data-shelley-cancel>Cancel</button><button class="button primary" type="submit" data-shelley-submit>Make change</button></div></form>`;
    document.body.append(dialog);
    const form = dialog.querySelector('form');
    const textarea = dialog.querySelector('textarea');
    const status = dialog.querySelector('[data-shelley-status]');
    const submit = dialog.querySelector('[data-shelley-submit]');
    const cancel = dialog.querySelector('[data-shelley-cancel]');
    const close = dialog.querySelector('.dialog-close');
    let completed = false;
    const closeDialog = () => { if (!submit.disabled) dialog.close(); };
    dialog.addEventListener('cancel',event=>{if(submit.disabled)event.preventDefault();});
    close.addEventListener('click',closeDialog);
    cancel.addEventListener('click',closeDialog);
    triggers.forEach(button=>button.addEventListener('click',()=>{
      completed = false; form.reset(); status.textContent=''; submit.disabled=false; cancel.disabled=false; submit.textContent='Make change';
      dialog.showModal(); setTimeout(()=>textarea.focus(),0);
    }));
    const poll = async id => {
      for (let attempt=0; attempt<450; attempt++) {
        await new Promise(resolve=>setTimeout(resolve,2000));
        const response = await fetch(`/api/shelley/jobs/${encodeURIComponent(id)}`);
        if (!response.ok) throw new Error((await response.text()).trim() || 'Unable to check Shelley status');
        const job = await response.json();
        status.textContent = job.message || 'Shelley is working…';
        if (job.status === 'done') return job;
        if (job.status === 'error') throw new Error(job.message || 'Shelley could not complete the edit');
      }
      throw new Error('Shelley is still working. Open Edit with Shelley again later to check the page.');
    };
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      if (completed) { location.reload(); return; }
      const prompt = textarea.value.trim();
      if (prompt.length < 3) { status.textContent='Describe the requested change.'; textarea.focus(); return; }
      const songID = currentVisibleSongID();
      if (!songID) { status.textContent='Open a song or live-set song to request a focused edit.'; return; }
      submit.disabled=true; cancel.disabled=true; close.disabled=true; status.textContent='Sending the focused edit to Shelley…';
      try {
        const response = await fetch('/api/shelley/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,song_id:songID,path:location.pathname})});
        if (!response.ok) throw new Error((await response.text()).trim() || 'Unable to start Shelley');
        const job = await response.json();
        await poll(job.id);
        completed=true; submit.disabled=false; close.disabled=false; submit.textContent='Reload page'; status.textContent='Change complete. Reload to see the updated lead sheet.';
      } catch (error) {
        status.textContent=error.message; submit.disabled=false; cancel.disabled=false; close.disabled=false;
      }
    });
  }

  function setupMarkdownEditor() {
    const triggers = [...document.querySelectorAll('[data-markdown-edit]')];
    if (!triggers.length || !('HTMLDialogElement' in window)) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'shelley-dialog markdown-dialog';
    dialog.innerHTML = `<form method="dialog"><header><div><p class="eyebrow">Canonical source</p><h2>Edit Markdown</h2></div><button class="dialog-close" type="button" aria-label="Close">×</button></header><p class="dialog-help">Edit the song file for structure and phrasing. You need TWO SPACES at the line's end to create a rendered NEW line. Use <code>&lt;!-- column-break --&gt;</code> on its own line to start the second tablet column.</p><label><span>Lead-sheet Markdown</span><textarea name="markdown" required aria-label="Lead-sheet Markdown" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea></label><p class="shelley-job-status" data-markdown-status aria-live="polite"></p><div class="dialog-actions"><button class="button" type="button" data-markdown-cancel>Cancel</button><button class="button primary" type="submit" data-markdown-save>Save Markdown</button></div></form>`;
    document.body.append(dialog);
    const form = dialog.querySelector('form');
    const textarea = dialog.querySelector('textarea');
    const status = dialog.querySelector('[data-markdown-status]');
    const save = dialog.querySelector('[data-markdown-save]');
    const cancel = dialog.querySelector('[data-markdown-cancel]');
    const close = dialog.querySelector('.dialog-close');
    let songID = '', expectedHash = '', initialMarkdown = '', saving = false, saved = false, loadVersion = 0;
    const syncEditorViewport = () => {
      const viewport=window.visualViewport;
      dialog.style.setProperty('--editor-viewport-height',`${Math.round(viewport?.height||innerHeight)}px`);
      dialog.style.setProperty('--editor-viewport-top',`${Math.round(viewport?.offsetTop||0)}px`);
    };
    window.visualViewport?.addEventListener('resize',syncEditorViewport);
    window.visualViewport?.addEventListener('scroll',syncEditorViewport);
    const requestClose = () => {
      if (saving) return;
      if (!saved && textarea.value !== initialMarkdown && !confirm('Discard your unsaved Markdown changes?')) return;
      loadVersion++;
      dialog.close();
    };
    dialog.addEventListener('cancel',event=>{event.preventDefault();requestClose();});
    close.addEventListener('click',requestClose);
    cancel.addEventListener('click',requestClose);
    textarea.addEventListener('keydown',event=>{
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase()==='s') { event.preventDefault(); form.requestSubmit(); }
    });
    triggers.forEach(button=>button.addEventListener('click',async()=>{
      const version=++loadVersion;
      songID = currentVisibleSongID(); expectedHash=''; initialMarkdown=''; saved=false; saving=false;
      textarea.value=''; textarea.disabled=true; save.disabled=true; cancel.disabled=false; close.disabled=false; save.textContent='Save Markdown';
      status.textContent='Loading canonical Markdown…'; syncEditorViewport(); dialog.showModal();
      if (!songID) { status.textContent='No song is currently selected.'; return; }
      try {
        const response = await fetch(`/api/songs/${encodeURIComponent(songID)}/markdown`,{cache:'no-store'});
        if (!response.ok) throw new Error((await response.text()).trim() || 'Unable to load Markdown');
        const data = await response.json();
        if (version !== loadVersion || !dialog.open) return;
        expectedHash=data.hash; textarea.value=data.markdown; initialMarkdown=textarea.value; textarea.disabled=false; save.disabled=false; status.textContent='';
        setTimeout(()=>textarea.focus(),0);
      } catch (error) { status.textContent=error.message; }
    }));
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      if (saved) { location.reload(); return; }
      if (!songID || !expectedHash || textarea.disabled) return;
      saving=true; textarea.disabled=true; save.disabled=true; cancel.disabled=true; close.disabled=true; status.textContent='Validating and saving Markdown…';
      try {
        const response = await fetch(`/api/songs/${encodeURIComponent(songID)}/markdown`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({markdown:textarea.value,expected_hash:expectedHash})});
        if (!response.ok) throw new Error((await response.text()).trim() || 'Unable to save Markdown');
        const result = await response.json();
        initialMarkdown=textarea.value; saved=true; saving=false; status.textContent=result.warning || 'Markdown saved. Reloading…';
        try {
          if(result.warning)sessionStorage.setItem('songs-flash-warning',result.warning);
          else sessionStorage.removeItem('songs-flash-warning');
        } catch {}
        location.reload();
      } catch (error) {
        saving=false; textarea.disabled=false; save.disabled=false; cancel.disabled=false; close.disabled=false; status.textContent=error.message;
      }
    });
  }

  async function verifySetFits(setID) {
    const ids = [...document.querySelectorAll('.set-entry-list a[href^="/song/"]')].map(link => link.getAttribute('href').split('/').pop());
    if (!ids.length) throw new Error('Set list contains no songs');
    const panel = document.createElement('article');
    panel.className = 'lead-sheet-panel';
    panel.dataset.leadSheet = '';
    panel.style.cssText = 'position:fixed;left:-10000px;top:0;width:calc(100vw - 24px);height:calc(100dvh - 72px);visibility:hidden';
    panel.innerHTML = '<header class="sheet-header"><h1>Song</h1></header><div class="sheet-viewport" data-sheet-viewport><div class="apex-source" data-apex-source></div><div class="live-columns" data-live-columns></div></div>';
    document.body.append(panel);
    const failures = [];
    try {
      for (const id of ids) {
        const data = await fetch(`/api/songs/${id}`).then(response => { if (!response.ok) throw new Error(`Unable to load ${id}`); return response.json(); });
        panel.querySelector('[data-apex-source]').innerHTML = data.html;
        panel.querySelector('h1').textContent = data.title;
        await fitSheet(panel);
        if (panel.dataset.fitStatus === 'needs-editing') failures.push(id);
      }
    } finally {
      panel.remove();
    }
    return {failed: failures, checked: ids.length, set: setID};
  }

  function setupLyricsPicker() {
    const searchButton = document.querySelector('[data-lyrics-search]');
    const results = document.querySelector('[data-lyrics-results]');
    const status = document.querySelector('[data-lyrics-status]');
    const title = document.querySelector('input[name="title"]');
    const artist = document.querySelector('input[name="artist"]');
    const performanceKey = document.querySelector('input[name="key"]');
    const performanceBPM = document.querySelector('input[name="bpm"]');
    const originalKey = document.querySelector('input[name="original_key"]');
    const originalBPM = document.querySelector('input[name="original_bpm"]');
    const mirrorOriginal = (original, performance) => {
      if (!original || !performance) return;
      let previousOriginal = original.value;
      original.addEventListener('input', () => {
        if (!performance.value || performance.value === previousOriginal) performance.value = original.value;
        previousOriginal = original.value;
      });
    };
    mirrorOriginal(originalKey, performanceKey);
    mirrorOriginal(originalBPM, performanceBPM);
    if (!searchButton || !results || !status || !title) return;
    const duration = seconds => seconds ? `${Math.floor(seconds/60)}:${String(Math.round(seconds%60)).padStart(2,'0')}` : '';
    const setStatus = message => { status.textContent = message; };
    const useChoice = async (choice, button) => {
      button.disabled = true;
      setStatus(`Generating lead sheet from ${choice.provider}…`);
      try {
        const response = await fetch('/api/lyrics/import', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(choice)});
        if (!response.ok) throw new Error((await response.text()).trim() || 'Unable to import lyrics');
        const draft = await response.json();
        title.value = draft.title || choice.title;
        if (artist) artist.value = draft.artist || choice.artist;
        const importedBPM = draft.original_bpm || '';
        if (originalBPM) originalBPM.value = importedBPM;
        if (performanceBPM && !performanceBPM.value) performanceBPM.value = importedBPM;
        document.querySelector('input[name="source_url"]').value = draft.source_url || '';
        document.querySelector('input[name="source_provider"]').value = draft.source_provider || choice.provider;
        const body = document.querySelector('textarea[name="body"]');
        body.value = draft.body || '';
        results.hidden = true;
        setStatus(`Draft generated from ${draft.source_provider || choice.provider}. Review it, add performance details, then create the lead sheet.`);
        body.scrollIntoView({behavior:'smooth',block:'center'});
        body.focus();
      } catch (error) {
        setStatus(error.message);
      } finally {
        button.disabled = false;
      }
    };
    const renderChoices = choices => {
      results.replaceChildren();
      for (const choice of choices) {
        const card = document.createElement('article');
        card.className = 'lyrics-choice';
        const text = document.createElement('div');
        const heading = document.createElement('h3');
        heading.textContent = choice.title;
        const details = document.createElement('p');
        details.textContent = [choice.artist, choice.album, duration(choice.duration), choice.provider].filter(Boolean).join(' · ');
        text.append(heading,details);
        const use = document.createElement('button');
        use.type = 'button'; use.className = 'button primary'; use.textContent = 'Use this version';
        use.addEventListener('click',()=>useChoice(choice,use));
        card.append(text,use); results.append(card);
      }
      results.hidden = choices.length === 0;
    };
    const search = async () => {
      const query = [artist?.value.trim(), title.value.trim()].filter(Boolean).join(' ');
      if (query.length < 2) { setStatus('Enter a song title or artist.'); title.focus(); return; }
      searchButton.disabled = true; results.hidden = true; setStatus('Searching lyrics providers…');
      try {
        const params = new URLSearchParams({title:title.value.trim()});
        if (artist?.value.trim()) params.set('artist', artist.value.trim());
        const response = await fetch(`/api/lyrics/search?${params}`);
        if (!response.ok) throw new Error((await response.text()).trim() || 'Lyrics search failed');
        const data = await response.json();
        renderChoices(data.choices || []);
        setStatus(data.choices?.length ? `Choose from ${data.choices.length} matching recordings.` : 'No matching lyrics found. Try a shorter title or add the artist.');
      } catch (error) {
        setStatus(error.message);
      } finally {
        searchButton.disabled = false;
      }
    };
    searchButton.addEventListener('click',search);
    for (const input of [title,artist]) input?.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();search();}});
  }

  async function setupOffline() {
    if ('serviceWorker' in navigator) await navigator.serviceWorker.register('/sw.js');
    const button=document.querySelector('[data-offline-set]'); if(!button)return;
    const status=document.querySelector('[data-offline-status]');
    button.addEventListener('click',async()=>{
      button.disabled=true; status.textContent='Preparing offline set…';
      try {
        const fit = await verifySetFits(button.dataset.offlineSet);
        if (fit.failed?.length) throw new Error(`${fit.failed.length} lead sheet${fit.failed.length === 1 ? '' : 's'} need editing for this viewport before offline use.`);
        const data=await fetch(`/api/offline/sets/${button.dataset.offlineSet}`).then(r=>{if(!r.ok)throw new Error('Unable to build offline manifest');return r.json();});
        const reg=await navigator.serviceWorker.ready; const worker=reg.active||reg.waiting||reg.installing;
        const done=new Promise((resolve,reject)=>{const handler=e=>{if(e.data?.type==='CACHE_COMPLETE'){navigator.serviceWorker.removeEventListener('message',handler);resolve();}if(e.data?.type==='CACHE_ERROR'){navigator.serviceWorker.removeEventListener('message',handler);reject(new Error(e.data.message));}};navigator.serviceWorker.addEventListener('message',handler);setTimeout(()=>reject(new Error('Offline preparation timed out')),45000);});
        worker.postMessage({type:'CACHE_URLS',urls:data.urls,set:data.set}); await done; status.textContent='Available offline on this device.';
      } catch(error){status.textContent=error.message;} finally{button.disabled=false;}
    });
  }

  function setupSongNavigation() {
    const previous=document.body.dataset.previousSong, next=document.body.dataset.nextSong;
    if(!previous&&!next)return;
    addEventListener('keydown',event=>{
      if(event.defaultPrevented||event.metaKey||event.ctrlKey||event.altKey||event.shiftKey)return;
      if(document.querySelector('dialog[open]')||(event.target instanceof Element&&event.target.closest('input,textarea,select,button,a,[contenteditable="true"]')))return;
      const destination=event.key==='ArrowUp'?previous:event.key==='ArrowDown'?next:'';
      if(!destination)return;
      event.preventDefault(); location.assign(destination);
    });
  }

  function setupLiveNavigation(){
    const scroller=document.querySelector('[data-live-scroller]'); if(!scroller)return;
    const panels=[...document.querySelectorAll('[data-live-panel]')],progress=document.querySelector('[data-live-progress]'); let current=0,scrollFrame=0;
    const syncCurrent=()=>{
      scrollFrame=0;
      const middle=innerHeight/2;
      let best=0,distance=Infinity;
      panels.forEach((panel,index)=>{const rect=panel.getBoundingClientRect(),delta=Math.abs(rect.top+Math.min(rect.height,innerHeight)/2-middle);if(delta<distance){distance=delta;best=index;}});
      current=best; activeLivePanel=panels[current]||null; if(progress)progress.textContent=`${current+1} / ${panels.length}`; refreshFontControls();
    };
    const go=i=>{current=Math.max(0,Math.min(panels.length-1,i));activeLivePanel=panels[current]||null;panels[current]?.scrollIntoView({behavior:'smooth',block:'start'});if(progress)progress.textContent=`${current+1} / ${panels.length}`;refreshFontControls();};
    document.querySelector('[data-live-prev]')?.addEventListener('click',()=>go(current-1)); document.querySelector('[data-live-next]')?.addEventListener('click',()=>go(current+1));
    addEventListener('keydown',e=>{if(['ArrowRight','ArrowDown','PageDown',' '].includes(e.key)){e.preventDefault();go(current+1)}if(['ArrowLeft','ArrowUp','PageUp'].includes(e.key)){e.preventDefault();go(current-1)}});
    scroller.addEventListener('scroll',()=>{if(!scrollFrame)scrollFrame=requestAnimationFrame(syncCurrent)},{passive:true});
    const observer=new IntersectionObserver(()=>{if(!scrollFrame)scrollFrame=requestAnimationFrame(syncCurrent)},{root:scroller,threshold:[0,.1,.5]}); panels.forEach(panel=>observer.observe(panel));
    syncCurrent();
  }

  window.SongsApp = { fitSheet, fitAll, detectFormFactor, setFormFactor };

  document.addEventListener('DOMContentLoaded',async()=>{
    setFormFactor(); setupFlashMessage(); setupTheme(); setupSearch(); setupSetSorting(); setupFontControls(); setupShelleyEditor(); setupMarkdownEditor(); setupLyricsPicker(); setupSongNavigation(); setupLiveNavigation(); await setupOffline(); await fitAll();
    new ResizeObserver(scheduleFit).observe(document.documentElement); window.visualViewport?.addEventListener('resize',scheduleFit); addEventListener('orientationchange',scheduleFit);
  });
})();
