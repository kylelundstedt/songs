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
    const forcedSplit = forcedColumnSplit(sections);
    let bestFailure = null;
    for (let px=MANUAL_MAX_PX; px>=MIN_PX; px--) {
      for (const line of [1.24,1.20,1.16,1.12]) {
        applyTypography(panel, px, line);
        const height = viewport.clientHeight;
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

  function layoutSetEntries(panel,list,entries,form) {
    const markedBreaks=entries.map((entry,index)=>entry.dataset.columnBreakBefore==='true'&&index>0?index:0).filter(Boolean).slice(0,2);
    const arrangedBreaks=panel.dataset.arranging==='true'&&panel.dataset.arrangeBreaks?panel.dataset.arrangeBreaks.split(',').map(Number).filter(offset=>offset>0&&offset<entries.length).slice(0,2):[];
    let boundaries=form==='phone'?[]:(arrangedBreaks.length?arrangedBreaks:markedBreaks);
    let columns;
    if(boundaries.length) columns=boundaries.length+1;
    else columns=form==='phone'?1:entries.length>24&&list.clientWidth>=820?3:entries.length>12&&list.clientWidth>=600?2:1;
    if(!boundaries.length&&columns>1) {
      const rows=Math.ceil(entries.length/columns);
      boundaries=Array.from({length:columns-1},(_,index)=>Math.min(entries.length,rows*(index+1)));
    }
    panel.dataset.setBreaks=(form==='phone'?(arrangedBreaks.length?arrangedBreaks:markedBreaks):boundaries).join(',');
    const starts=[0,...boundaries],ends=[...boundaries,entries.length],rows=Math.max(1,...starts.map((start,index)=>ends[index]-start));
    panel.style.setProperty('--set-columns',String(columns)); panel.style.setProperty('--set-rows',String(rows)); panel.dataset.columnCount=String(columns);
    starts.forEach((start,column)=>{for(let index=start;index<ends[column];index++){entries[index].style.gridColumn=String(column+1);entries[index].style.gridRow=String(index-start+1);}});
    return columns;
  }

  async function fitSetSheet(panel) {
    const viewport=panel.querySelector('[data-set-viewport]'),list=panel.querySelector('[data-set-entries]');
    if(!viewport||!list)return;
    await (document.fonts?.ready||Promise.resolve());
    const entries=[...list.querySelectorAll('.set-entry')],form=document.documentElement.dataset.formFactor||detectFormFactor();
    layoutSetEntries(panel,list,entries,form);
    if(form==='phone') {
      applySetTypography(panel,18,3); panel.dataset.fitStatus='scrollable'; return;
    }
    let low=11,high=Math.max(12,viewport.clientHeight),best=null;
    for(let attempt=0;attempt<12;attempt++) {
      const px=(low+high)/2,pad=px>=17?5:px>=14?4:2;
      applySetTypography(panel,px,pad);
      if(list.scrollHeight<=viewport.clientHeight+1&&list.scrollWidth<=viewport.clientWidth+1) {
        best={px,pad};low=px;
      } else high=px;
    }
    if(best) {
      applySetTypography(panel,Math.floor(best.px*10)/10,best.pad);
      panel.dataset.fitStatus='fit';return;
    }
    applySetTypography(panel,11,2);
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
      const q=raw.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu,'');
      let shown=0;
      rows.forEach(row=>{
        const hay=row.dataset.search.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu,'');
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
    const list=document.querySelector('[data-set-list]'),sort=document.querySelector('[data-set-sort]'),order=document.querySelector('[data-set-order]'),search=document.querySelector('[data-set-search]'),empty=document.querySelector('[data-set-no-results]'),resultStatus=document.querySelector('[data-set-result-status]');
    if(!list||!sort||!order)return;
    try {
      if(['date','title'].includes(localStorage.getItem('songs-set-sort')))sort.value=localStorage.getItem('songs-set-sort');
      if(['asc','desc'].includes(localStorage.getItem('songs-set-order')))order.value=localStorage.getItem('songs-set-order');
    } catch {}
    const collator=new Intl.Collator(undefined,{sensitivity:'base',numeric:true});
    const normalize=value=>(value||'').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu,'');
    const update=()=>{
      const rows=[...list.querySelectorAll('.set-row')],field=sort.value,direction=order.value==='asc'?1:-1,q=normalize(search?.value.trim());let shown=0;
      rows.sort((a,b)=>{
        const av=(field==='date'?a.dataset.setDate:a.dataset.setTitle)||'',bv=(field==='date'?b.dataset.setDate:b.dataset.setTitle)||'';
        if(!av||!bv)return !av&&!bv?0:!av?1:-1;
        return collator.compare(av,bv)*direction;
      });
      rows.forEach(row=>{row.hidden=!!q&&!normalize(row.dataset.setSearch).includes(q);if(!row.hidden)shown++;list.append(row);});
      if(empty)empty.hidden=shown!==0;
      if(resultStatus)resultStatus.textContent=`${shown} Set List${shown===1?'':'s'}`;
      try { localStorage.setItem('songs-set-sort',field); localStorage.setItem('songs-set-order',order.value); } catch {}
    };
    sort.addEventListener('change',update);order.addEventListener('change',update);search?.addEventListener('input',update);search?.addEventListener('keydown',event=>{if(event.key==='Escape'){search.value='';update();search.focus();}if(event.key==='Enter'){const visible=[...list.querySelectorAll('.set-row:not([hidden])')];if(visible.length===1){event.preventDefault();location.href=visible[0].href;}}});
    addEventListener('keydown',event=>{if(search&&event.key==='/'&&!/INPUT|TEXTAREA/.test(document.activeElement?.tagName)){event.preventDefault();search.focus();}});
    update();
  }

  function setupSetArrangement() {
    const panel=document.querySelector('[data-set-sheet]'),list=panel?.querySelector('[data-set-entries]'),add=document.querySelector('[data-set-add]'),removeMode=document.querySelector('[data-set-remove-mode]'),arrange=document.querySelector('[data-set-arrange]'),cancel=document.querySelector('[data-set-cancel]'),save=document.querySelector('[data-set-save]'),status=document.querySelector('[data-offline-status]');
    if(!panel||!list||!arrange||!cancel||!save||!status)return;
    let original=[],dragging=null,layoutFrame=0;
    const entries=()=>[...list.querySelectorAll('[data-set-item]')];
    const renumber=()=>entries().forEach((entry,index)=>entry.querySelector('.set-entry-position').textContent=String(index+1));
    const relayout=()=>{if(!layoutFrame)layoutFrame=requestAnimationFrame(async()=>{layoutFrame=0;await fitSetSheet(panel);});};
    const finishDrag=()=>{dragging?.classList.remove('is-dragging');list.querySelectorAll('.is-drop-target').forEach(entry=>entry.classList.remove('is-drop-target'));dragging=null;};
    arrange.addEventListener('click',()=>{
      original=entries(); delete panel.dataset.removing; if(removeMode){removeMode.textContent='Remove songs';removeMode.disabled=true;} panel.dataset.arranging='true'; panel.dataset.arrangeBreaks=panel.dataset.setBreaks||'';
      arrange.hidden=true; if(add)add.disabled=true; cancel.hidden=false; save.hidden=false; status.textContent='Drag songs within or across columns, then save.'; relayout();
    });
    cancel.addEventListener('click',()=>{
      finishDrag(); original.forEach(entry=>list.append(entry)); renumber(); delete panel.dataset.arranging; delete panel.dataset.arrangeBreaks;
      arrange.hidden=false; if(add)add.disabled=false; if(removeMode)removeMode.disabled=false; cancel.hidden=true; save.hidden=true; status.textContent=''; relayout();
    });
    list.addEventListener('pointerdown',event=>{
      const handle=event.target.closest('.set-drag-handle'); if(!handle||panel.dataset.arranging!=='true')return;
      dragging=handle.closest('[data-set-item]'); dragging.classList.add('is-dragging'); handle.setPointerCapture?.(event.pointerId); event.preventDefault();
    });
    list.addEventListener('pointermove',event=>{
      if(!dragging)return;
      const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-set-item]');
      list.querySelectorAll('.is-drop-target').forEach(entry=>entry.classList.remove('is-drop-target'));
      if(!target||target===dragging||!list.contains(target))return;
      target.classList.add('is-drop-target'); const rect=target.getBoundingClientRect();
      list.insertBefore(dragging,event.clientY<rect.top+rect.height/2?target:target.nextSibling); renumber(); relayout();
    });
    list.addEventListener('pointerup',finishDrag); list.addEventListener('pointercancel',finishDrag);
    list.addEventListener('keydown',event=>{
      if(panel.dataset.arranging!=='true'||!event.target.matches('.set-drag-handle')||!['ArrowUp','ArrowDown'].includes(event.key))return;
      const entry=event.target.closest('[data-set-item]'),items=entries(),index=items.indexOf(entry),targetIndex=event.key==='ArrowUp'?index-1:index+1;
      if(targetIndex<0||targetIndex>=items.length)return;
      event.preventDefault(); if(event.key==='ArrowUp')list.insertBefore(entry,items[targetIndex]);else list.insertBefore(items[targetIndex],entry); renumber(); relayout(); event.target.focus();
    });
    save.addEventListener('click',async()=>{
      finishDrag(); save.disabled=true; cancel.disabled=true; status.textContent='Saving set order…';
      const order=entries().map(entry=>Number(entry.dataset.originalPosition)),breaks=(panel.dataset.arrangeBreaks||'').split(',').map(Number).filter(Boolean);
      try {
        const response=await fetch(`/api/sets/${encodeURIComponent(panel.dataset.setId)}/order`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_hash:panel.dataset.setHash,order,breaks})});
        if(!response.ok)throw new Error((await response.text()).trim()||'Unable to save set order');
        const result=await response.json();
        try { if(result.warning)sessionStorage.setItem('songs-flash-warning',result.warning); } catch {}
        location.reload();
      } catch(error) { status.textContent=error.message; save.disabled=false; cancel.disabled=false; }
    });
  }

  function setupActionMenu() {
    const menu=document.querySelector('[data-action-menu]');
    if(!menu)return;
    menu.addEventListener('click',event=>{
      if(event.target.closest('a,button'))requestAnimationFrame(()=>{menu.open=false;});
    });
    document.addEventListener('pointerdown',event=>{if(menu.open&&!menu.contains(event.target))menu.open=false;});
    document.addEventListener('keydown',event=>{if(event.key==='Escape')menu.open=false;});
  }

  function setupSetPrint() {
    document.querySelector('[data-set-print]')?.addEventListener('click',()=>window.print());
    const panel=document.querySelector('[data-set-sheet]'),list=panel?.querySelector('[data-set-entries]'),copyButton=document.querySelector('[data-set-copy-sheets]'),csvButton=document.querySelector('[data-set-download-csv]'),status=document.querySelector('[data-offline-status]');
    if(!panel||!list||(!copyButton&&!csvButton))return;
    const columns=['Set','#','Song','Artist','Singer','Key','BPM','Note'];
    const clean=value=>String(value||'').replace(/[\t\r\n]+/g,' ').trim();
    const rows=()=>{
      let heading='Set 1';
      return [...list.querySelectorAll('[data-set-item]')].map((entry,index)=>{
        if(entry.dataset.exportHeading)heading=entry.dataset.exportHeading;
        return [heading,entry.querySelector('.set-entry-position')?.textContent.trim()||String(index+1),entry.dataset.exportTitle,entry.dataset.exportArtist,entry.dataset.exportSinger,entry.dataset.exportKey,entry.dataset.exportBpm,entry.dataset.exportNote].map(clean);
      });
    };
    const closeMenu=()=>{const menu=document.querySelector('[data-action-menu]');if(menu)menu.open=false;};
    const showStatus=message=>{if(!status)return;status.textContent=message;setTimeout(()=>{if(status.textContent===message)status.textContent='';},2400);};
    const copyText=async text=>{
      if(navigator.clipboard?.writeText){try{await navigator.clipboard.writeText(text);return;}catch{}}
      const textarea=document.createElement('textarea');textarea.value=text;textarea.style.cssText='position:fixed;left:-10000px;top:0;opacity:0';document.body.append(textarea);textarea.focus();textarea.select();const copied=document.execCommand('copy');textarea.remove();if(!copied)throw new Error('Clipboard access was unavailable');
    };
    copyButton?.addEventListener('click',async()=>{
      copyButton.disabled=true;
      try {const data=[columns,...rows()].map(row=>row.join('\t')).join('\n');await copyText(data);showStatus(`${data.split('\n').length-1} songs copied for Google Sheets.`);closeMenu();}
      catch(error){showStatus(error.message||'Unable to copy this Set List.');}
      finally{copyButton.disabled=false;}
    });
    csvButton?.addEventListener('click',()=>{
      const quote=value=>`"${String(value).replaceAll('"','""')}"`;
      const csv='\ufeff'+[columns,...rows()].map(row=>row.map(quote).join(',')).join('\r\n');
      const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));link.download=`${panel.dataset.setId||'set-list'}.csv`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(link.href),0);showStatus('CSV downloaded.');closeMenu();
    });
  }

  function setupSetItemEditing() {
    const panel=document.querySelector('[data-set-sheet]'),list=panel?.querySelector('[data-set-entries]'),add=document.querySelector('[data-set-add]'),removeMode=document.querySelector('[data-set-remove-mode]'),pageStatus=document.querySelector('[data-offline-status]');
    if(!panel||!list||!add||!removeMode||!pageStatus)return;
    let catalog=null,expectedHash='';
    const setNoteButtonsDisabled=disabled=>list.querySelectorAll('[data-set-note-edit]').forEach(noteButton=>{noteButton.disabled=disabled;});
    const dialog=document.createElement('dialog');
    dialog.className='shelley-dialog set-item-dialog';
    dialog.innerHTML=`<form method="dialog"><header><div><p class="eyebrow">Set List</p><h2>Add song</h2></div><button class="dialog-close" type="button" aria-label="Close">×</button></header><label><span>Find a song</span><input type="search" data-set-song-search placeholder="Title or artist" autocomplete="off"></label><label><span>Song</span><select data-set-song-options size="8" required aria-label="Song"></select></label><div class="set-item-fields"><label><span>Singer</span><input name="singer" maxlength="120" autocomplete="off"></label><label><span>Performance key</span><input name="key" maxlength="40" placeholder="Uses lead sheet" autocomplete="off"></label><label><span>Performance bpm</span><input name="bpm" maxlength="40" inputmode="decimal" placeholder="Optional" autocomplete="off"></label><label><span>Destination</span><select name="column" data-set-column required></select></label></div><label><span>Note</span><input name="note" maxlength="500" autocomplete="off"></label><p class="shelley-job-status" data-set-item-status aria-live="polite"></p><div class="dialog-actions"><button class="button" type="button" data-set-item-cancel>Cancel</button><button class="button primary" type="submit" data-set-item-save>Add song</button></div></form>`;
    document.body.append(dialog);
    const form=dialog.querySelector('form'),search=dialog.querySelector('[data-set-song-search]'),options=dialog.querySelector('[data-set-song-options]'),columns=dialog.querySelector('[data-set-column]'),status=dialog.querySelector('[data-set-item-status]'),save=dialog.querySelector('[data-set-item-save]'),cancel=dialog.querySelector('[data-set-item-cancel]'),close=dialog.querySelector('.dialog-close');
    const closeDialog=()=>{if(!save.disabled)dialog.close();}; close.addEventListener('click',closeDialog);cancel.addEventListener('click',closeDialog);
    const renderSongs=()=>{
      const query=search.value.trim().toLocaleLowerCase(); options.innerHTML='';
      const matches=(catalog||[]).filter(song=>!query||`${song.title} ${song.artist||''} ${song.id}`.toLocaleLowerCase().includes(query)).slice(0,250);
      matches.forEach(song=>{const option=document.createElement('option');option.value=song.id;option.textContent=song.artist?`${song.title} — ${song.artist}`:song.title;options.append(option);});
      options.selectedIndex=-1; status.textContent=matches.length?`${matches.length}${matches.length===250?' matching':''} song${matches.length===1?'':'s'}`:'No matching songs';
    };
    search.addEventListener('input',renderSongs);
    search.addEventListener('keydown',event=>{if(event.key==='ArrowDown'&&options.options.length){event.preventDefault();options.focus();options.selectedIndex=0;}});
    removeMode.addEventListener('click',()=>{
      const active=panel.dataset.removing!=='true';
      if(active){panel.dataset.removing='true';removeMode.textContent='Done removing';pageStatus.textContent='Choose Delete beside any song you want to remove.';}
      else{delete panel.dataset.removing;removeMode.textContent='Remove songs';pageStatus.textContent='';}
    });
    add.addEventListener('click',async()=>{
      if(panel.dataset.arranging==='true')return;
      delete panel.dataset.removing;removeMode.textContent='Remove songs';pageStatus.textContent='';
      form.reset();options.innerHTML='';columns.innerHTML='';expectedHash=panel.dataset.setHash;save.disabled=true;cancel.disabled=false;close.disabled=false;status.textContent='Loading song catalog…';
      const marked=[...list.querySelectorAll('[data-column-break-before="true"]')].length;
      for(let index=1;index<=marked+1;index++){const option=document.createElement('option');option.value=String(index);option.textContent=marked?`Set ${index}`:'End of Set List';columns.append(option);}
      dialog.showModal();
      try { if(!catalog){const response=await fetch('/api/catalog',{cache:'no-store'});if(!response.ok)throw new Error('Unable to load song catalog');catalog=await response.json();}renderSongs();save.disabled=false;setTimeout(()=>search.focus(),0); }
      catch(error){status.textContent=error.message;}
    });
    form.addEventListener('submit',async event=>{
      event.preventDefault();const songID=options.value;if(!songID){status.textContent='Select a song to add.';options.focus();return;}
      save.disabled=true;cancel.disabled=true;close.disabled=true;status.textContent='Adding song and saving Set List…';
      try {
        const response=await fetch(`/api/sets/${encodeURIComponent(panel.dataset.setId)}/items`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_hash:expectedHash,song_id:songID,singer:form.elements.singer.value,key:form.elements.key.value,bpm:form.elements.bpm.value,note:form.elements.note.value,column:Number(form.elements.column.value)})});
        if(!response.ok)throw new Error((await response.text()).trim()||'Unable to add song');const result=await response.json();
        try{if(result.warning)sessionStorage.setItem('songs-flash-warning',result.warning);}catch{} location.reload();
      } catch(error){status.textContent=error.message;save.disabled=false;cancel.disabled=false;close.disabled=false;}
    });
    list.addEventListener('click',event=>{
      const button=event.target.closest('[data-set-note-edit]');
      if(!button||panel.dataset.arranging==='true'||panel.dataset.removing==='true')return;
      const entry=button.closest('[data-set-item]'),content=entry.querySelector('.set-entry-content');
      const existingInput=content.querySelector('.set-note-input');
      if(existingInput){existingInput.focus();return;}
      let noteElement=content.querySelector('[data-set-note]');
      let placeholder=content.querySelector('[data-set-placeholder]');
      const initial=noteElement?.textContent.trim()||'';
      const input=document.createElement('input');
      input.className='set-note-input';input.type='text';input.maxLength=160;input.value=initial;input.autocomplete='off';input.setAttribute('aria-label','Short performance note');
      if(noteElement)noteElement.hidden=true;if(placeholder)placeholder.hidden=true;content.append(input);input.focus();input.select();
      let finished=false,saving=false;
      const restore=async()=>{if(finished)return;finished=true;input.remove();if(noteElement)noteElement.hidden=false;if(placeholder)placeholder.hidden=false;button.disabled=false;await fitSetSheet(panel);};
      const saveNote=async()=>{
        if(finished||saving)return;
        const note=input.value.trim();if(note===initial){await restore();return;}
        saving=true;input.disabled=true;setNoteButtonsDisabled(true);pageStatus.textContent='Saving note…';
        try {
          const response=await fetch(`/api/sets/${encodeURIComponent(panel.dataset.setId)}/items/${encodeURIComponent(entry.dataset.originalPosition)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_hash:panel.dataset.setHash,note})});
          if(!response.ok){const error=new Error((await response.text()).trim()||'Unable to save note');error.status=response.status;throw error;}
          const result=await response.json();panel.dataset.setHash=result.hash;
          if(note){
            if(!noteElement){noteElement=document.createElement('small');noteElement.dataset.setNote='';content.append(noteElement);}
            noteElement.textContent=note;noteElement.hidden=false;if(placeholder)placeholder.hidden=true;
          } else {
            noteElement?.remove();noteElement=null;
            if(entry.classList.contains('set-entry-unresolved')){
              if(!placeholder){placeholder=document.createElement('small');placeholder.dataset.setPlaceholder='';placeholder.textContent='Unresolved imported song';content.append(placeholder);}
              placeholder.hidden=false;
            }
          }
          finished=true;input.remove();setNoteButtonsDisabled(false);pageStatus.textContent=result.warning||'Note saved.';setTimeout(()=>{if(pageStatus.textContent==='Note saved.')pageStatus.textContent='';},1600);await fitSetSheet(panel);
        } catch(error){saving=false;input.disabled=false;setNoteButtonsDisabled(false);pageStatus.textContent=error.status===409?'Set List changed elsewhere. Reload before saving this note.':error.message;input.focus();}
      };
      input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();saveNote();}else if(event.key==='Escape'){event.preventDefault();restore();}});
      input.addEventListener('blur',saveNote);
    });
    list.addEventListener('click',async event=>{
      const button=event.target.closest('[data-set-delete]');if(!button||panel.dataset.arranging==='true'||panel.dataset.removing!=='true')return;
      const entry=button.closest('[data-set-item]'),title=entry.querySelector('.set-entry-title a,.set-entry-title > span')?.textContent.trim()||'this song';
      if(!confirm(`Delete “${title}” from this Set List?`))return;
      button.disabled=true;pageStatus.textContent=`Deleting ${title}…`;
      try {
        const response=await fetch(`/api/sets/${encodeURIComponent(panel.dataset.setId)}/items/${encodeURIComponent(entry.dataset.originalPosition)}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_hash:panel.dataset.setHash})});
        if(!response.ok)throw new Error((await response.text()).trim()||'Unable to delete song');const result=await response.json();
        try{if(result.warning)sessionStorage.setItem('songs-flash-warning',result.warning);}catch{} location.reload();
      } catch(error){pageStatus.textContent=error.message;button.disabled=false;}
    });
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
    const hasSong=!!currentVisibleSongID();
    document.querySelectorAll('[data-shelley-edit],[data-markdown-edit]:not([data-markdown-kind="set"])').forEach(button=>{
      if(!button.dataset.enabledTitle)button.dataset.enabledTitle=button.title||button.getAttribute('aria-label')||'Edit';
      button.disabled=!hasSong;
      button.title=hasSong?button.dataset.enabledTitle:'Unavailable for an unresolved Set List item';
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
    dialog.innerHTML = `<form method="dialog"><header><div><p class="eyebrow">Canonical source</p><h2>Edit Markdown</h2></div><button class="dialog-close" type="button" aria-label="Close">×</button></header><p class="dialog-help" data-markdown-help></p><label><span data-markdown-label>Markdown</span><textarea name="markdown" required aria-label="Canonical Markdown" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea></label><p class="shelley-job-status" data-markdown-status aria-live="polite"></p><div class="dialog-actions"><button class="button" type="button" data-markdown-cancel>Cancel</button><button class="button primary" type="submit" data-markdown-save>Save Markdown</button></div></form>`;
    document.body.append(dialog);
    const form = dialog.querySelector('form');
    const textarea = dialog.querySelector('textarea');
    const help = dialog.querySelector('[data-markdown-help]');
    const label = dialog.querySelector('[data-markdown-label]');
    const status = dialog.querySelector('[data-markdown-status]');
    const save = dialog.querySelector('[data-markdown-save]');
    const cancel = dialog.querySelector('[data-markdown-cancel]');
    const close = dialog.querySelector('.dialog-close');
    let resourceKind = 'songs', resourceID = '', expectedHash = '', initialMarkdown = '', saving = false, saved = false, loadVersion = 0;
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
    textarea.addEventListener('input',()=>{
      if (saving || textarea.disabled) return;
      save.disabled=textarea.value===initialMarkdown;
      if (!save.disabled && status.textContent==='No changes to save.') status.textContent='';
    });
    triggers.forEach(button=>button.addEventListener('click',async()=>{
      const version=++loadVersion;
      const editingSet=button.dataset.markdownKind==='set';
      resourceKind=editingSet?'sets':'songs'; resourceID=editingSet?button.dataset.markdownId:currentVisibleSongID();
      expectedHash=''; initialMarkdown=''; saved=false; saving=false;
      help.innerHTML=editingSet?'Edit Set List details and numbered song entries. Add a heading such as <code>## Set 1 — Slow</code> immediately before that Set\'s first song. Put <code>&lt;!-- column-break --&gt;</code> immediately before each later Set heading.':'Edit the song file for structure and phrasing. You need TWO SPACES at the line\'s end to create a rendered NEW line. Use <code>&lt;!-- column-break --&gt;</code> on its own line to start the second tablet column.';
      label.textContent=editingSet?'Set List Markdown':'Lead-sheet Markdown';
      textarea.value=''; textarea.disabled=true; save.disabled=true; cancel.disabled=false; close.disabled=false; save.textContent='Save Markdown';
      status.textContent='Loading canonical Markdown…'; syncEditorViewport(); dialog.showModal();
      if (!resourceID) { status.textContent=editingSet?'No Set List is currently selected.':'No song is currently selected.'; return; }
      try {
        const response = await fetch(`/api/${resourceKind}/${encodeURIComponent(resourceID)}/markdown`,{cache:'no-store'});
        if (!response.ok) throw new Error((await response.text()).trim() || 'Unable to load Markdown');
        const data = await response.json();
        if (version !== loadVersion || !dialog.open) return;
        expectedHash=data.hash; textarea.value=data.markdown; initialMarkdown=textarea.value; textarea.disabled=false; save.disabled=true; status.textContent='';
        setTimeout(()=>textarea.focus(),0);
      } catch (error) { status.textContent=error.message; }
    }));
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      if (saved) { location.reload(); return; }
      if (!resourceID || !expectedHash || textarea.disabled) return;
      if (textarea.value===initialMarkdown) { status.textContent='No changes to save.'; save.disabled=true; return; }
      saving=true; textarea.disabled=true; save.disabled=true; cancel.disabled=true; close.disabled=true; status.textContent='Validating and saving Markdown…';
      try {
        const response = await fetch(`/api/${resourceKind}/${encodeURIComponent(resourceID)}/markdown`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({markdown:textarea.value,expected_hash:expectedHash})});
        if (!response.ok) { const error=new Error((await response.text()).trim() || 'Unable to save Markdown'); error.status=response.status; throw error; }
        const result = await response.json();
        initialMarkdown=textarea.value; saved=true; saving=false; status.textContent=result.warning || 'Markdown saved. Reloading…';
        try {
          if(result.warning)sessionStorage.setItem('songs-flash-warning',result.warning);
          else sessionStorage.removeItem('songs-flash-warning');
        } catch {}
        location.reload();
      } catch (error) {
        saving=false; textarea.disabled=false; save.disabled=textarea.value===initialMarkdown; cancel.disabled=false; close.disabled=false;
        status.textContent=error.status===409?'This Set List changed after the editor opened. Copy any draft changes, close the editor, reload this page, and reopen Edit Markdown.':error.message;
      }
    });
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
    if (!('serviceWorker' in navigator)) return;
    const registration=await navigator.serviceWorker.register('/sw.js');
    const candidate=registration.installing||registration.waiting;
    if(candidate&&candidate.state!=='activated')await new Promise(resolve=>{
      const timeout=setTimeout(resolve,15000);
      candidate.addEventListener('statechange',()=>{if(candidate.state==='activated'||candidate.state==='redundant'){clearTimeout(timeout);resolve();}});
    });
    const ready=await navigator.serviceWorker.ready;
    const worker=ready.active||registration.active;
    if(!worker)return;

    const notice=document.createElement('div');
    notice.className='offline-library-notice';notice.hidden=true;notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');document.body.append(notice);
    const detail=document.querySelector('[data-offline-library-detail]');
    const updateButton=document.querySelector('[data-offline-library-update]');
    const removeButton=document.querySelector('[data-offline-library-remove]');
    const snapshotDetail=document.querySelector('[data-offline-snapshot]');
    const contentsDetail=document.querySelector('[data-offline-contents]');
    const sizeDetail=document.querySelector('[data-offline-size]');
    const persistenceDetail=document.querySelector('[data-offline-persistence]');
    const updatedDetail=document.querySelector('[data-offline-updated]');
    let libraryReady=false,activeJob=null,hideTimer=0;
    const formatBytes=value=>{if(!Number.isFinite(value)||value<1)return '—';if(value<1024)return `${value} B`;if(value<1048576)return `${(value/1024).toFixed(1)} KB`;return `${(value/1048576).toFixed(1)} MB`;};
    const updateDiagnostics=async status=>{
      const ready=!!status?.ready||!!status?.snapshot_id;
      if(snapshotDetail)snapshotDetail.textContent=ready?String(status.snapshot_id).slice(0,12):'—';
      if(contentsDetail){const count=status?.resource_count??status?.total;contentsDetail.textContent=ready&&Number.isFinite(count)?`${count} resources`:'—';}
      if(sizeDetail)sizeDetail.textContent=ready?formatBytes(status?.byte_size):'—';
      if(updatedDetail){const date=status?.updated_at?new Date(status.updated_at):null;updatedDetail.textContent=date&&!Number.isNaN(date.valueOf())?date.toLocaleString():'—';}
      if(persistenceDetail){
        let persisted=null,usage=null;
        try { persisted=await navigator.storage?.persisted?.();usage=(await navigator.storage?.estimate?.())?.usage; } catch {}
        persistenceDetail.textContent=persisted===true?`Persistent${Number.isFinite(usage)?` · ${formatBytes(usage)} used`:''}`:persisted===false?`Browser managed${Number.isFinite(usage)?` · ${formatBytes(usage)} used`:''}`:'Unavailable';
      }
    };
    const newJobID=()=>globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const show=(message,state='working',sticky=false)=>{
      clearTimeout(hideTimer);notice.textContent=message;notice.dataset.state=state;notice.hidden=false;if(detail)detail.textContent=message;
      if(!sticky&&state==='ready'&&navigator.onLine)hideTimer=setTimeout(()=>{notice.hidden=true;},4500);
    };
    const formatReady=updatedAt=>{
      if(!updatedAt)return 'Offline library ready.';
      const date=new Date(updatedAt);return Number.isNaN(date.valueOf())?'Offline library ready.':`Offline library ready · updated ${date.toLocaleDateString()}.`;
    };
    const setControls=busy=>{if(updateButton)updateButton.disabled=busy||!navigator.onLine;if(removeButton)removeButton.disabled=busy||!libraryReady;};
    const requestWorker=(type,terminalTypes,timeout=600000)=>new Promise((resolve,reject)=>{
      const jobID=newJobID();let finished=false;
      const finish=callback=>{if(finished)return;finished=true;clearTimeout(timer);navigator.serviceWorker.removeEventListener('message',onMessage);callback();};
      const onMessage=event=>{
        const data=event.data||{};if(data.job_id!==jobID)return;
        if(data.type==='LIBRARY_CACHE_PROGRESS'){
          if(data.phase==='manifest')show('Checking offline library…','working',true);
          if(data.phase==='resources')show(`Preparing offline library… ${data.completed}/${data.total}`,'working',true);
          return;
        }
        if(data.type==='LIBRARY_CACHE_ERROR')finish(()=>reject(Object.assign(new Error(data.message||'Unable to prepare offline library'),{preserved:data.preserved_active_snapshot})));
        else if(terminalTypes.includes(data.type))finish(()=>resolve(data));
      };
      const timer=setTimeout(()=>finish(()=>reject(new Error('Offline library operation timed out'))),timeout);
      navigator.serviceWorker.addEventListener('message',onMessage);worker.postMessage({type,job_id:jobID});
    });
    const readStatus=async()=>{
      const status=await requestWorker('GET_LIBRARY_STATUS',['LIBRARY_CACHE_STATUS'],15000);
      libraryReady=!!status.ready;setControls(false);await updateDiagnostics(status);return status;
    };
    const updateLibrary=async(manual=false)=>{
      if(activeJob)return activeJob;
      if(!navigator.onLine){show(libraryReady?'Offline · saved library available.':'Offline library has not been downloaded.','offline',true);return;}
      setControls(true);
      activeJob=(async()=>{
        try {
          const result=await requestWorker('UPDATE_LIBRARY',['LIBRARY_CACHE_COMPLETE']);
          libraryReady=true;setControls(false);
          try { sessionStorage.setItem('songs-offline-last-check',String(Date.now())); } catch {}
          try { await navigator.storage?.persist?.(); } catch {}
          await updateDiagnostics({ready:true,resource_count:result.total,...result});
          const message=result.unchanged?formatReady(result.updated_at):`Offline library ready · ${result.total} resources saved.`;
          show(message,'ready',manual);
        } catch(error) {
          setControls(false);
          show(error.preserved?'Offline update failed · previous library preserved.':error.message,'error',true);
        } finally { activeJob=null; }
      })();
      return activeJob;
    };
    const updateNetworkState=()=>{
      document.documentElement.dataset.network=navigator.onLine?'online':'offline';
      setControls(!!activeJob);
      if(!navigator.onLine)show(libraryReady?'Offline · saved library available.':'Offline · no saved library available.','offline',true);
      else if(libraryReady)show(formatReady(),'ready');
    };
    document.addEventListener('click',event=>{
      if(navigator.onLine)return;
      const target=event.target.closest('[data-markdown-edit],[data-shelley-edit],[data-set-add],[data-set-remove-mode],[data-set-arrange],[data-set-save],[data-set-delete],[data-set-note-edit],[data-add-song],[data-add-missing-song],.listen-menu a');
      if(!target)return;event.preventDefault();show('This action requires an internet connection.','offline',true);
    },true);
    updateButton?.addEventListener('click',()=>updateLibrary(true));
    removeButton?.addEventListener('click',async()=>{
      if(!libraryReady||!confirm('Remove the downloaded offline library from this device?'))return;
      setControls(true);
      try { await requestWorker('REMOVE_LIBRARY',['LIBRARY_CACHE_REMOVED'],60000);libraryReady=false;await updateDiagnostics({ready:false});show('Offline library removed.','ready',true); }
      catch(error){show(error.message,'error',true);} finally{setControls(false);}
    });
    addEventListener('offline',updateNetworkState);
    addEventListener('online',()=>{updateNetworkState();updateLibrary(false);});
    try {
      const status=await readStatus();
      let checkedRecently=false;
      try { checkedRecently=Date.now()-Number(sessionStorage.getItem('songs-offline-last-check')||0)<300000; } catch {}
      if(!Number.isFinite(status.byte_size))checkedRecently=false;
      if(!navigator.onLine)show(status.ready?formatReady(status.updated_at):'Offline · no saved library available.','offline',true);
      else if(!status.ready||!checkedRecently)await updateLibrary(false);
      else show(formatReady(status.updated_at),'ready');
    } catch(error) { show(error.message,'error',true); }
    updateNetworkState();
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
    setFormFactor(); setupFlashMessage(); setupTheme(); setupSearch(); setupSetSorting(); setupSetArrangement(); setupActionMenu(); setupSetPrint(); setupSetItemEditing(); setupFontControls(); setupShelleyEditor(); setupMarkdownEditor(); setupLyricsPicker(); setupSongNavigation(); setupLiveNavigation();
    setupOffline().catch(error=>console.error('Offline library setup failed',error));
    await fitAll();
    new ResizeObserver(scheduleFit).observe(document.documentElement); window.visualViewport?.addEventListener('resize',scheduleFit); addEventListener('orientationchange',scheduleFit);
  });
})();
