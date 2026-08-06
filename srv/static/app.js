(() => {
  'use strict';
  const MIN_PX = 16;
  const PREFERRED_PX = 21;
  let refitTimer;

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

  function expandFlowNodes(source) {
    const expanded = [];
    for (const node of [...source.children].filter(node => node.tagName !== 'H1')) {
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

  function sectionize(source) {
    const nodes = expandFlowNodes(source);
    const sections = [];
    let headingGroup = null;
    const push = section => {
      section.dataset.sectionIndex = String(sections.length);
      sections.push(section);
    };
    for (const node of nodes) {
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

  function renderColumns(container, sections, count, split) {
    container.replaceChildren();
    if (count === 1) {
      const col = makeColumn();
      sections.forEach(s => col.append(s.cloneNode(true)));
      container.append(col);
      return [col];
    }
    const left = makeColumn(), right = makeColumn();
    sections.forEach((s,i) => (i < split ? left : right).append(s.cloneNode(true)));
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
      panel.dataset.columnCount = '1'; panel.dataset.bodyPx = '20';
      return;
    }

    const gap = parseFloat(getComputedStyle(container).columnGap || getComputedStyle(container).gap) || 24;
    const width = (viewport.clientWidth-gap)/2;
    const height = viewport.clientHeight;
    let bestFailure = null;
    for (let px=PREFERRED_PX; px>=MIN_PX; px--) {
      for (const line of [1.24,1.20,1.16,1.12]) {
        applyTypography(panel, px, line);
        const heights = measureSections(sections,width,panel,px,line);
        const split = bestSplit(heights);
        const leftHeight = heights.slice(0,split).reduce((a,b)=>a+b,0);
        const rightHeight = heights.slice(split).reduce((a,b)=>a+b,0);
        const columns = renderColumns(container,sections,2,split);
        const fits = leftHeight <= height+1 && rightHeight <= height+1 && columns.every(horizontalSafe) && horizontalSafe(container);
        if (fits) {
          panel.dataset.fitStatus='fit'; panel.dataset.columnCount='2'; panel.dataset.bodyPx=String(px); panel.dataset.lineHeight=String(line);
          return;
        }
        const overflow=Math.max(0,leftHeight-height,rightHeight-height);
        if (!bestFailure || overflow<bestFailure.overflow) bestFailure={px,line,split,overflow};
      }
    }
    const fail=bestFailure || {px:MIN_PX,line:1.12,split:Math.ceil(sections.length/2),overflow:0};
    applyTypography(panel,MIN_PX,1.12); renderColumns(container,sections,2,fail.split);
    panel.dataset.fitStatus='needs-editing'; panel.dataset.columnCount='2'; panel.dataset.bodyPx=String(MIN_PX); panel.dataset.lineHeight='1.12';
  }

  async function fitAll() { for (const panel of document.querySelectorAll('[data-lead-sheet]')) await fitSheet(panel); }
  function scheduleFit() { clearTimeout(refitTimer); refitTimer=setTimeout(fitAll,100); }

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

  async function verifySetFits(setID) {
    const ids = [...document.querySelectorAll('.set-list a[href^="/song/"]')].map(link => link.getAttribute('href').split('/').pop());
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
        document.querySelector('input[name="original_bpm"]').value = draft.original_bpm || '';
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

  function setupLiveNavigation(){
    const scroller=document.querySelector('[data-live-scroller]');if(!scroller)return;const panels=[...document.querySelectorAll('[data-live-panel]')],progress=document.querySelector('[data-live-progress]');let current=0;
    const go=i=>{current=Math.max(0,Math.min(panels.length-1,i));panels[current]?.scrollIntoView({behavior:'smooth',block:'start'});if(progress)progress.textContent=`${current+1} / ${panels.length}`;};
    document.querySelector('[data-live-prev]')?.addEventListener('click',()=>go(current-1));document.querySelector('[data-live-next]')?.addEventListener('click',()=>go(current+1));
    addEventListener('keydown',e=>{if(['ArrowRight','ArrowDown','PageDown',' '].includes(e.key)){e.preventDefault();go(current+1)}if(['ArrowLeft','ArrowUp','PageUp'].includes(e.key)){e.preventDefault();go(current-1)}});
    const observer=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting&&entry.intersectionRatio>.6){current=panels.indexOf(entry.target);if(progress)progress.textContent=`${current+1} / ${panels.length}`;}}),{root:scroller,threshold:[.6]});panels.forEach(p=>observer.observe(p));
  }

  window.SongsApp = { fitSheet, fitAll, detectFormFactor, setFormFactor };

  document.addEventListener('DOMContentLoaded',async()=>{
    setFormFactor(); setupTheme(); setupSearch(); setupLyricsPicker(); setupLiveNavigation(); await setupOffline(); await fitAll();
    new ResizeObserver(scheduleFit).observe(document.documentElement); window.visualViewport?.addEventListener('resize',scheduleFit); addEventListener('orientationchange',scheduleFit);
  });
})();
