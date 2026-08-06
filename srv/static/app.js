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
        headingGroup.append(node.cloneNode(true));
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
    const badge = panel.querySelector('[data-fit-badge]');
    const detail = panel.querySelector('[data-fit-detail]');
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
      badge.textContent = safe ? '1 column · scroll' : 'Needs editing';
      detail.textContent = safe ? 'Phone fallback · 20px · vertical scrolling allowed' : 'Horizontal overflow detected';
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
          badge.textContent=`2 columns · ${px}px`; detail.textContent=`Single viewport · line height ${line.toFixed(2)}`;
          return;
        }
        const overflow=Math.max(0,leftHeight-height,rightHeight-height);
        if (!bestFailure || overflow<bestFailure.overflow) bestFailure={px,line,split,overflow};
      }
    }
    const fail=bestFailure || {px:MIN_PX,line:1.12,split:Math.ceil(sections.length/2),overflow:0};
    applyTypography(panel,MIN_PX,1.12); renderColumns(container,sections,2,fail.split);
    panel.dataset.fitStatus='needs-editing'; panel.dataset.columnCount='2'; panel.dataset.bodyPx=String(MIN_PX); panel.dataset.lineHeight='1.12';
    badge.textContent='Needs editing'; detail.textContent=`Two-column overflow: ${Math.ceil(fail.overflow)}px at 16px minimum`;
  }

  async function fitAll() { for (const panel of document.querySelectorAll('[data-lead-sheet]')) await fitSheet(panel); }
  function scheduleFit() { clearTimeout(refitTimer); refitTimer=setTimeout(fitAll,100); }

  function setupTheme() {
    const saved=localStorage.getItem('songs-theme') || 'stage';
    document.documentElement.dataset.theme=saved;
    const update=()=>document.querySelectorAll('[data-theme-toggle]').forEach(b=>b.textContent=document.documentElement.dataset.theme==='stage'?'Bright':'Stage');
    update();
    document.querySelectorAll('[data-theme-toggle]').forEach(button=>button.addEventListener('click',()=>{
      const next=document.documentElement.dataset.theme==='stage'?'bright':'stage'; document.documentElement.dataset.theme=next; localStorage.setItem('songs-theme',next); update(); scheduleFit();
    }));
  }

  function setupSearch() {
    const input=document.querySelector('#song-search'); if(!input)return;
    const rows=[...document.querySelectorAll('.song-row')], count=document.querySelector('#song-count'), empty=document.querySelector('#no-results');
    input.addEventListener('input',()=>{const q=input.value.toLowerCase().replace(/[^a-z0-9]+/g,'');let shown=0;rows.forEach(row=>{const hay=row.dataset.search.toLowerCase().replace(/[^a-z0-9]+/g,'');const match=!q||hay.includes(q);row.hidden=!match;if(match)shown++;});count.textContent=`${shown} songs`;empty.hidden=shown!==0;});
  }

  async function verifySetFits(setID) {
    const ids = [...document.querySelectorAll('.set-list a[href^="/song/"]')].map(link => link.getAttribute('href').split('/').pop());
    if (!ids.length) throw new Error('Set list contains no songs');
    const panel = document.createElement('article');
    panel.className = 'lead-sheet-panel';
    panel.dataset.leadSheet = '';
    panel.style.cssText = 'position:fixed;left:-10000px;top:0;width:calc(100vw - 24px);height:calc(100dvh - 72px);visibility:hidden';
    panel.innerHTML = '<header class="sheet-header"><div><p class="eyebrow">Fit check</p><h1>Song</h1></div><span data-fit-badge></span></header><div class="sheet-viewport" data-sheet-viewport><div class="apex-source" data-apex-source></div><div class="live-columns" data-live-columns></div></div><footer class="sheet-footer"><span data-fit-detail></span></footer>';
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
    setFormFactor(); setupTheme(); setupSearch(); setupLiveNavigation(); await setupOffline(); await fitAll();
    new ResizeObserver(scheduleFit).observe(document.documentElement); window.visualViewport?.addEventListener('resize',scheduleFit); addEventListener('orientationchange',scheduleFit);
  });
})();
