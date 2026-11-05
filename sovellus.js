// Niittoraportin käyttöliittymä: kolmivaiheinen polku (lohko → tiedot → tulos).
// Riippuu tiedostoista core.js (NiittoCore), datahaku.js (NiittoHaku) ja kartta.js (NiittoKartta).
(function(){
  var C=window.NiittoCore, HK=window.NiittoHaku, KT=window.NiittoKartta, root=document.documentElement;
  var $=function(id){return document.getElementById(id)};
  $('ver').textContent=C.VERSION;
  function getStore(k){try{return localStorage.getItem(k)}catch(e){return null}}
  function setStore(k,v){try{localStorage.setItem(k,v)}catch(e){}}
  function getSess(k){try{return sessionStorage.getItem(k)}catch(e){return null}}
  function setSess(k,v){try{if(v==null)sessionStorage.removeItem(k);else sessionStorage.setItem(k,v)}catch(e){}}
  var saved=getStore('theme'); if(saved) root.setAttribute('data-theme',saved);
  $('themeBtn').addEventListener('click',function(){
    var cur=root.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
    var nx=cur==='dark'?'light':'dark'; root.setAttribute('data-theme',nx); setStore('theme',nx); render();
  });
  function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')}
  function fx(v,d){return v.toFixed(d).replace('.',',')}
  function fiShort(d){var p=d.split('-');return (+p[2])+'.'+(+p[1])+'.'}

  // ---------- Välilehdet ----------
  var tabs=Array.prototype.slice.call(document.querySelectorAll('nav.tabs button'));
  function show(id,focus){
    tabs.forEach(function(b){var on=b.dataset.tab===id;b.setAttribute('aria-selected',on?'true':'false');b.tabIndex=on?0:-1;if(on&&focus)b.focus()});
    document.querySelectorAll('section.panel').forEach(function(s){s.classList.toggle('active',s.id===id)});
    document.body.setAttribute('data-tab',id);
    if(history.replaceState) history.replaceState(null,'','#'+id);
    if(id==='tyokalu'&&step===1) ensureMap();
  }
  tabs.forEach(function(b,i){
    b.addEventListener('click',function(){show(b.dataset.tab)});
    b.addEventListener('keydown',function(e){
      var j=null; if(e.key==='ArrowRight')j=(i+1)%tabs.length; else if(e.key==='ArrowLeft')j=(i-1+tabs.length)%tabs.length; else if(e.key==='Home')j=0; else if(e.key==='End')j=tabs.length-1;
      if(j!==null){e.preventDefault();show(tabs[j].dataset.tab,true)}
    });
  });
  document.querySelectorAll('[data-goto]').forEach(function(a){a.addEventListener('click',function(e){e.preventDefault();show(a.dataset.goto);window.scrollTo(0,0)})});

  // ---------- Vaiheet ----------
  var step=1, maxStep=1, stepBtns=Array.prototype.slice.call(document.querySelectorAll('#stepNav button'));
  function goStep(n,noScroll){
    step=n; maxStep=Math.max(maxStep,n);
    [1,2,3].forEach(function(i){$('step'+i).hidden=i!==n});
    stepBtns.forEach(function(b){
      var i=+b.dataset.step;
      if(i===n) b.setAttribute('aria-current','step'); else b.removeAttribute('aria-current');
      b.disabled=i>maxStep||(i>1&&!fieldState); b.classList.toggle('done',i<n);
    });
    if(n===1) ensureMap();
    if(!noScroll){var top=$('tyokalu').getBoundingClientRect().top+window.scrollY-60; if(window.scrollY>top) window.scrollTo(0,Math.max(0,top))}
  }
  stepBtns.forEach(function(b){b.addEventListener('click',function(){if(!b.disabled) goStep(+b.dataset.step)})});
  $('toStep2').addEventListener('click',function(){if(fieldState) goStep(2)});
  $('back1').addEventListener('click',function(){goStep(1)});
  $('back2').addEventListener('click',function(){goStep(2)});
  $('newField').addEventListener('click',function(){goStep(1);var i=$('pltIn');i.value='';i.focus()});
  $('manualGo').addEventListener('click',function(){goStep(3);$('tech').open=true;$('tech').scrollIntoView({block:'start'})});
  $('printBtn').addEventListener('click',function(){window.print()});

  // ---------- Toimenpide (radiopainikkeet) ----------
  var measureBox=$('measureOpts'), MUU='muu';
  Object.keys(C.RULES).concat([MUU]).forEach(function(k){
    var l=document.createElement('label'); l.className='rcard';
    var title=k===MUU?'Lohkolla on viljaa tai muu kasvi':k, sub=k===MUU?'Niittoraportti ei sovellu':C.RULES[k].note;
    l.innerHTML='<input type="radio" name="measureR" value="'+esc(k)+'"><span><b>'+esc(title)+'</b><span class="small muted">'+esc(sub)+'</span></span>';
    measureBox.appendChild(l);
  });
  var mRadios=Array.prototype.slice.call(measureBox.querySelectorAll('input'));
  var measureSel={
    get value(){var r=mRadios.filter(function(x){return x.checked})[0];return r&&r.value!==MUU?r.value:''},
    set value(v){mRadios.forEach(function(r){r.checked=!!v&&r.value===v})},
    isMuu:function(){return mRadios.some(function(r){return r.checked&&r.value===MUU})}
  };
  measureSel.value='Luonnonhoitonurmi';
  measureBox.addEventListener('change',function(){$('cropOk').checked=false;render()});

  var parcelInfo={kasvi:null,vuosi:null,lahde:null}, fieldKey=null, lastParcel=null;
  $('srcList').textContent=C.SOURCES.join(', ');
  var PKEYS=['ndviDrop','confMin','minValid','minChanged','maxGap','persistWindow','s1k'];
  function resetP(){PKEYS.forEach(function(k){$('p_'+k).value=C.DEFAULTS[k]});render()}
  PKEYS.forEach(function(k){var el=$('p_'+k);el.value=C.DEFAULTS[k];el.addEventListener('input',render)});
  $('resetP').addEventListener('click',resetP);

  // ---------- Havaintotaulukko ----------
  var tbody=document.querySelector('#obsTable tbody');
  function num(v){return v==null||v===''||isNaN(v)?'':v}
  function addRow(d){
    d=d||{};
    var tr=document.createElement('tr');
    var opts=C.SOURCES.filter(function(s){return s.indexOf('täydennys')<0}).map(function(s){return '<option'+(s===d.src?' selected':'')+'>'+s+'</option>'}).join('');
    tr.innerHTML='<td><input type="date" class="d" aria-label="Päivä" value="'+esc(d.date)+'"></td>'+
      '<td><select class="s" aria-label="Lähde">'+opts+'</select></td>'+
      '<td><input class="i" aria-label="Kuvatunniste" placeholder="tunniste" value="'+esc(d.id)+'"></td>'+
      '<td><input class="v num" aria-label="Arvo" type="number" step="0.01" value="'+num(d.value)+'"></td>'+
      '<td><input class="va num" aria-label="Kelvolliset pikselit %" type="number" step="1" min="0" max="100" value="'+num(d.valid)+'"></td>'+
      '<td><input class="ch num" aria-label="Muuttunut osuus %" type="number" step="1" min="0" max="100" value="'+num(d.changed)+'"></td>'+
      '<td><button class="del" type="button" aria-label="Poista rivi">×</button></td>';
    tr.querySelector('.del').addEventListener('click',function(){tr.remove();exampleOn=false;render()});
    tr.querySelectorAll('input,select').forEach(function(el){el.addEventListener('input',function(){exampleOn=false;render()})});
    tbody.appendChild(tr);
  }
  function pf(el){var v=el.value;return v===''?null:parseFloat(v)}
  function readObs(){
    return Array.prototype.map.call(tbody.querySelectorAll('tr'),function(tr){
      return {date:tr.querySelector('.d').value,src:tr.querySelector('.s').value,id:tr.querySelector('.i').value.trim(),
        value:pf(tr.querySelector('.v')),valid:pf(tr.querySelector('.va')),changed:pf(tr.querySelector('.ch'))};
    }).filter(function(o){return o.date&&((o.value!=null&&!isNaN(o.value))||(o.valid!=null&&!isNaN(o.valid)))});
  }
  function readP(){
    var p={measure:measureSel.value,bufferM:parseFloat($('buffer').value)||0};
    PKEYS.forEach(function(k){var v=parseFloat($('p_'+k).value);if(!isNaN(v))p[k]=v});
    return p;
  }
  function css(v){return getComputedStyle(root).getPropertyValue(v).trim()}
  var COL={HLS:'--accent',S2:'--blue',PS:'--warn',S1:'--violet',S1B:'--violet'};
  var NAME={HLS:'HLS',S2:'Sentinel-2',PS:'PlanetScope',S1:'S1-koherenssi',S1B:'S1 VH-takaisinsironta'};
  var current=null, exampleOn=false;
  $('cropOk').addEventListener('change',function(){render()});

  function seasonYear(){ var v=($('dStart')||{}).value||''; return parseInt(v.slice(0,4),10)||null }
  // Kasvin ja toimenpiteen yhteensopivuus: Ruokaviraston kasvi → toimenpide (kartta.js measureFor)
  function cropState(){
    var m=measureSel.value, k=parcelInfo.kasvi, expected=k?KT.measureFor(k):null;
    var conflict=!m||(k&&expected!==m);
    return {conflict:conflict, confirmed:$('cropOk').checked, kasvi:k, expected:expected, measure:m};
  }
  // Pääarvio: HLS ja Sentinel-2 L2A yhdistetään päivämäärittäin (core.fuse). L2A täyttää HLS:n puuttuvat
  // granulit, ja ristiriitaiset maskit merkitään epävarmoiksi. Samoja kuvia ei lasketa riippumattomiksi lähteiksi.
  var fuseInfo=null;
  function mainObs(obs){ var f=C.fuse(obs,readP()); fuseInfo=f.info; return f.obs }
  function factFrom(checks,re){return checks.filter(function(c){return re.test(c.t)})[0]||null}

  function render(){
    var obsAll=readObs(), obs=mainObs(obsAll), p=readP(), muu=measureSel.isMuu();
    var lohko=$('lohko').value.trim()||'[kasvulohkon tunnus]';
    var rule=C.RULES[p.measure];
    $('ruleNote').textContent=rule?rule.note+' Lähde: peltovalvontaohje 2026.':'';
    $('notSuited').hidden=!muu; $('runGo').disabled=muu||busy;
    var cs=cropState(), cw=$('cropWarn'), cwt=$('cropWarnText');
    cw.hidden=!cs.conflict||muu;
    if(cs.conflict){
      cwt.innerHTML=cs.kasvi
        ? '<strong>Lohkon kasvi on Ruokaviraston aineistossa „'+esc(cs.kasvi)+'”'+(parcelInfo.vuosi?' ('+parcelInfo.vuosi+')':'')+'.</strong> '+(cs.expected?'Se vastaa toimenpidettä '+esc(cs.expected)+', ei valittua toimenpidettä.':'Kasvilla ei ole niittovelvoitetta, joten NDVI:n lasku on todennäköisesti sadonkorjuuta, puintia tai tuleentumista eikä niittoa.')+' Vipu-tekstiä ei muodosteta, ennen kuin vahvistat toimenpiteen.'
        : '<strong>Valitse lohkon toimenpide.</strong> Vipu-tekstiä ei muodosteta ilman toimenpidettä.';
      $('cropOk').parentNode.hidden=!cs.measure;
    }
    var season=seasonYear(), yearNote=parcelInfo.vuosi&&season&&parcelInfo.vuosi!==season?'Lohkon rajaus ja kasvi ovat Ruokaviraston vuoden '+parcelInfo.vuosi+' aineistosta, arvioitava kausi on '+season+'. Tarkista, että ne ovat samat tänä vuonna.':null;
    // Merkintä vain esimerkkidatalle; teksti tyhjennetään, ettei se näy tekstinä luettaessa piilotettunakaan.
    $('exBadge').hidden=!exampleOn; $('exBadge').textContent=exampleOn?'keksitty esimerkkidata':'';
    $('resMeta').textContent='Kasvulohko '+lohko+(p.measure?' · '+p.measure:'')+(season?' · '+season:'');
    updateCode(obs);
    renderCompare(obsAll,p);
    renderMonitor(obsAll,p);
    var v=$('verdict'), ck=$('checks'), ev=$('events'), facts=$('facts'), bwEl=$('bigwarns'), meter=$('meter');
    var out=$('out'), svg=$('chart');
    if(obs.filter(function(o){return o.value!=null&&!isNaN(o.value)}).length<2){
      v.className='muted';v.textContent='Lisää vähintään kaksi saman lähteen havaintoa.';
      ck.innerHTML='';ev.innerHTML='';facts.innerHTML='';bwEl.innerHTML='';out.value='';svg.innerHTML='';$('legend').innerHTML='';
      setMeter(null);current=null;$('techSum').textContent='tarkistukset, tapahtumat ja havaintotaulukko';
      $('outEmpty').textContent='Teksti muodostuu, kun havainnot on haettu.';setLen();return;
    }
    var res=C.analyze(obs,p);
    current={ohjelma:'Niittoraportti',versio:res.version,laadittu:new Date().toISOString().slice(0,10),lohko:lohko,toimenpide:p.measure,
      tulos:res.verdict,parametrit:res.params,tapahtumat:res.events.map(slimEv),hylatyt_pudotukset:res.rejected.map(function(r){return {lahde:r.fam,alku:r.start,loppu:r.end,pudotus:r.drop,syy:r.reason}}),
      pois_jatetyt_havainnot:res.excluded.map(function(x){return {havainto:x.obs,syy:x.reason}}),havainnot:res.used.map(function(o){return {paiva:o.date,lahde:o.src,tunniste:o.id,arvo:o.value,kelvolliset:o.valid,muuttunut:o.changed}}),
      lahteet:['De Vroey ym. 2022, doi:10.1016/j.rse.2022.113145','Claverie ym. 2018, doi:10.1016/j.rse.2018.09.002','Tamm ym. 2016, doi:10.3390/rs8100802','Kolecka ym. 2018, doi:10.3390/rs10081221','Ruokavirasto, peltovalvontaohje 2026']};
    if(cmpCache) current.lahdevertailu=cmpCache;
    if(monCache) current.seuranta=monCache;
    if(fuseInfo&&fuseInfo.mode==='HLS + L2A') current.yhdistaminen={hls_l2a:true,l2a_taydennyksia:fuseInfo.filled,maskiristiriitoja:fuseInfo.conflicts};
    var vd=res.verdict, b=res.best;
    v.className='';
    v.innerHTML='<div class="verdict v-'+vd.level+'">'+esc(vd.label)+'</div><div class="vdetail">'+
      (b?'Satelliittikuvissa kasvusto väheni '+C.fi(b.start)+'–'+C.fi(b.end)+' ('+b.fams.map(function(f){return NAME[f]}).join(' + ')+'). ':'')+esc(vd.detail)+'.</div>';
    setMeter(vd.level);
    var checks=b?b.checks:[], slow=checks.filter(function(c){return /tuleentum/.test(c.t)&&c.s==='warn'});
    // Avainluvut
    var f='';
    if(b){
      var tm=factFrom(checks,/määräpäiv|aikaisintaan|sallittua|alkaa ennen/), chg=factFrom(checks,/Muuttun/);
      f+='<div><dt>Niittoväli</dt><dd>'+fiShort(b.start)+'–'+fiShort(b.end)+'</dd></div>';
      if(tm) f+='<div class="'+(tm.s==='ok'?'ok':tm.s==='warn'?'w':'f')+'"><dt>'+(rule&&rule.latest?'Ennen '+rule.latest.split('-').reverse().map(Number).join('.')+'.':'Ajoitus')+'</dt><dd>'+(tm.s==='ok'?'Kyllä':tm.s==='warn'?'Epävarma':'Ei')+'</dd></div>';
      if(chg){var m=/(\d+) %/.exec(chg.t); f+='<div class="'+(chg.s==='ok'?'ok':chg.s==='warn'?'w':'f')+'"><dt>Muuttunut ala</dt><dd>'+(m?m[1]+' %':'–')+'</dd></div>'}
      f+='<div><dt>Luottamus</dt><dd>'+fx(b.conf,2)+'</dd></div>';
    }
    facts.innerHTML=f;
    var bw='';
    if(cs.conflict&&!cs.confirmed) bw+='<div class="bigwarn"><strong>Tarkista toimenpide.</strong> '+(cs.kasvi?'Lohkon kasvi on „'+esc(cs.kasvi)+'”. ':'')+'Tulos ei ole näyttöä niitosta ennen kuin toimenpide on vahvistettu vaiheessa 2.</div>';
    if(slow.length&&b) bw+='<div class="bigwarn"><strong>Hidas muutos: tarkista, että kyse on niitosta.</strong> '+(function(){var d=b.dets.filter(function(x){return (x.notes||[]).some(function(n){return /tuleentum/.test(n)})})[0];return d?'Pudotus näkyi vasta '+Math.round(d.gap)+' vrk havaintovälin yli ('+C.fi(d.before.date)+'–'+C.fi(d.after.date)+')':'Havaintoväli on pitkä'})()+', ja NDVI:n hidas lasku voi olla myös tuleentumista, kuivuutta tai sadonkorjuuta. Liitä kuva niitosta, jos sinulla on sellainen.</div>';
    if(yearNote) bw+='<div class="bigwarn">'+esc(yearNote)+'</div>';
    if(res.post&&res.post.n<C.DEFAULTS.postDeadline&&rule&&rule.latest) bw+='<div class="bigwarn"><strong>Jatka hakujaksoa määräpäivän yli.</strong> Määräpäivän '+C.fi(res.post.deadline)+' jälkeen '+(res.post.n?'on vain '+res.post.n+' selkeä kuva':'ei ole yhtään selkeää kuvaa')+'. Tarvitaan vähintään '+C.DEFAULTS.postDeadline+', jotta nähdään, pysyykö NDVI matalana tai palautuuko se asteittain. Siirrä loppupäivää vaiheessa 2 (esim. '+C.fi(res.post.deadline.slice(0,4)+'-10-15')+').</div>';
    bwEl.innerHTML=bw;
    var nWarn=checks.filter(function(c){return c.s==='warn'}).length;
    ck.innerHTML=(b?'<li class="info" style="list-style:none;margin-left:-20px"><strong>Tarkistukset</strong> · '+(nWarn?nWarn+(nWarn===1?' huomautus':' huomautusta'):'ei huomautuksia')+'</li>':'')+
      checks.filter(function(c){return slow.indexOf(c)<0}).map(function(c){return '<li class="'+c.s+'">'+esc(c.t)+'</li>'}).join('');
    if(res.excluded.length){
      ck.innerHTML+='<li class="info"><details><summary>'+res.excluded.length+(res.excluded.length===1?' havainto jätettiin':' havaintoa jätettiin')+' pois (pilvisyys tai liian vähän kelvollisia pikseleitä)</summary><ul class="small muted">'+
        res.excluded.map(function(x){return '<li>'+C.fi(x.obs.date)+' '+esc(x.obs.src)+': '+esc(x.reason)+'</li>'}).join('')+'</ul></details></li>';
    }
    if(fuseInfo&&fuseInfo.mode==='HLS + L2A') ck.innerHTML+='<li class="info">HLS ja Sentinel-2 L2A yhdistettiin päivämäärittäin: L2A täytti '+fuseInfo.filled+' päivää, joilta HLS-kuva puuttui tai oli maskin hylkäämä'+(fuseInfo.conflicts?', ja '+fuseInfo.conflicts+' päivän maskit tai arvot olivat ristiriidassa (havainto merkitty epävarmaksi)':'')+'.</li>';
    $('techSum').textContent=(nWarn?nWarn+(nWarn===1?' huomautus':' huomautusta'):'ei huomautuksia')+' · '+res.used.length+' havaintoa käytetty, '+res.excluded.length+' jätetty pois';
    var h='';
    if(res.events.length){h+='<h3>Tunnistetut tapahtumat</h3>';res.events.forEach(function(e){
      h+='<div class="ev'+(e.accepted?' acc':'')+'"><strong>'+C.fi(e.start)+'–'+C.fi(e.end)+'</strong> · luottamus '+e.conf+' · '+e.fams.map(function(f){return NAME[f]}).join(' + ')+' · '+(e.accepted?'<span style="color:var(--accent)">ylittää rajan</span>':'<span class="muted">alle rajan</span>')+
      '<div class="muted small">'+e.dets.map(function(d){return NAME[d.fam]+': '+(d.fam==='S1'?'z = '+d.z:'NDVI '+d.before.value.toFixed(2)+' → '+d.after.value.toFixed(2)+', pysyvyys: '+d.persistence)}).join(' · ')+'</div></div>'})}
    if(res.rejected.length){h+='<h3>Hylätyt pudotukset</h3>';res.rejected.forEach(function(r){h+='<div class="ev"><strong>'+C.fi(r.start)+'–'+C.fi(r.end)+'</strong> · '+NAME[r.fam]+' · pudotus '+r.drop+'<div class="muted small">'+esc(r.reason)+'</div></div>'})}
    ev.innerHTML=h;
    var txt=(cs.conflict&&!cs.confirmed)?'':C.reportText(res,lohko,p.measure);
    if(txt){
      var src=[];
      if(parcelInfo.vuosi) src.push('Rajaus: Ruokaviraston kasvulohkoaineisto '+parcelInfo.vuosi+(parcelInfo.kasvi?' (kasvi '+parcelInfo.kasvi+')':'')+'.');
      if(cs.conflict&&cs.confirmed) src.push('Toimenpide '+p.measure+' viljelijän ilmoituksen mukaan.');
      txt=txt+(src.length?' '+src.join(' '):'');
    }
    out.value=txt;
    $('outEmpty').textContent=txt?'':(cs.conflict&&!cs.confirmed)?'Vahvista toimenpide vaiheessa 2, niin teksti muodostuu.':'Tekstiä ei muodosteta, koska niittoa ei tunnistettu tai tukiehto ei täyty.';
    current.lohkoaineisto={vuosi:parcelInfo.vuosi,kasvi:parcelInfo.kasvi,lahde:parcelInfo.lahde,kausi:season,toimenpide_vahvistettu:cs.conflict?cs.confirmed:null};
    setLen();
    drawChart(svg,res,null);
  }
  function setMeter(level){
    var n={strong:3,moderate:2,weak:1,fail:1,none:0}[level]||0, L={strong:'Vahva',moderate:'Kohtalainen',weak:'Heikko',fail:'Ehto ei täyty',none:'Ei näyttöä'};
    var m=$('meter'); m.className='meter'+(level?' lv-'+level:'');
    Array.prototype.forEach.call(m.querySelectorAll('i'),function(i,k){i.classList.toggle('on',k<n)});
    m.querySelector('span').textContent=level?L[level]:'';
    m.setAttribute('aria-label','Näytön vahvuus: '+(level?L[level]:'ei tulosta'));
    m.hidden=!level;
  }
  function slimEv(e){return {alku:e.start,loppu:e.end,luottamus:e.conf,hyvaksytty:e.accepted,lahteet:e.fams,tarkistukset:e.checks,
    tunnistukset:e.dets.map(function(d){return {lahde:d.fam,alku:d.start,loppu:d.end,ennen:{paiva:d.before.date,tunniste:d.before.id,arvo:d.before.value},jalkeen:{paiva:d.after.date,tunniste:d.after.id,arvo:d.after.value},pudotus:d.drop,z:d.z,pysyvyys:d.persistence,muuttunut:d.changed,luottamus:Math.round(d.conf*100)/100}})}}
  function setLen(){var o=$('out');$('outLen').textContent=o.value?'('+o.value.length+' merkkiä)':'';$('copy').disabled=!o.value;$('dlJson').disabled=!current;$('printBtn').disabled=!current}

  // ---------- Lähdevertailu ----------
  var cmpCache=null;
  function renderCompare(obs,p){
    var fams={}; obs.forEach(function(o){var f=C.FAMILY[o.src]; if(f&&f!=='S1') fams[f]=1});
    var box=$('compare');
    if(Object.keys(fams).length<2){box.hidden=true;cmpCache=null;return}
    var r=C.compareSources(obs,p); box.hidden=false;
    var det=r.rows.filter(function(x){return x.detected}), bestW=det.length?Math.min.apply(null,det.map(function(x){return x.windowDays})):null;
    var head='<thead><tr><th>Lähteet</th><th>Kelvollisia päiviä</th><th>Kuvaväli, mediaani</th><th>Pisin väli</th><th>Niitto</th><th>Niittoväli</th><th>Luottamus</th></tr></thead>';
    var body=r.rows.map(function(x){
      return '<tr><td>'+esc(x.label)+'</td><td class="num">'+x.nObs+'</td><td class="num">'+(x.gapMedian==null?'–':Math.round(x.gapMedian)+' vrk')+'</td><td class="num">'+(x.gapMax==null?'–':Math.round(x.gapMax)+' vrk')+'</td>'+
        '<td>'+(x.detected?'tunnistettu':'<span class="muted">ei</span>')+'</td>'+
        '<td class="num'+(x.detected&&x.windowDays===bestW?' best':'')+'">'+(x.detected?fiShort(x.start)+'–'+fiShort(x.end)+' ('+Math.round(x.windowDays)+' vrk)':'–')+'</td>'+
        '<td class="num">'+(x.conf==null?'–':fx(x.conf,2))+'</td></tr>';
    }).join('');
    $('cmpTable').innerHTML=head+'<tbody>'+body+'</tbody>';
    var s=r.summary, cls=s&&s.verdict==='better'?'better':'';
    var lead=!s?'':s.verdict==='better'?'Kyllä: lisälähteet paransivat niiton havaitsemista tällä lohkolla.':s.verdict==='same'?'Ei tällä lohkolla: lisälähteet eivät muuttaneet tulosta.':'Vertailu ei ratkennut.';
    $('cmpSummary').innerHTML=s?'<div class="cmpv '+cls+'"><strong>'+esc(lead)+'</strong><ul>'+s.text.map(function(t){return '<li>'+esc(t)+'</li>'}).join('')+'</ul></div>':'';
    cmpCache={johtopaatos:s?s.verdict:null,yhteenveto:s?s.text:[],rivit:r.rows};
  }

  // ---------- Ruokaviraston kaltainen seuranta ----------
  var monCache=null, LIGHT_CSS={green:'ok',yellow:'w',red:'f'};
  function renderMonitor(obsAll,p){
    var box=$('rvCard'), withVal=obsAll.filter(function(o){return o.value!=null&&!isNaN(o.value)});
    if(withVal.length<2){box.hidden=true;monCache=null;return}
    var q=Object.assign({},p,{start:$('dStart').value||null,end:$('dEnd').value||null});
    var r=C.monitorCompare(obsAll,q), base=r.rows.filter(function(x){return x.key==='RV'})[0]||r.rows.filter(function(x){return x.key==='S2'})[0]||r.rows[0];
    if(!base){box.hidden=true;monCache=null;return}
    box.hidden=false;
    var bs={RV:['Sentinel-2','Sentinel-1 koherenssi','Sentinel-1 VH'],S2:['Sentinel-2'],S1:['Sentinel-1 koherenssi','Sentinel-1 VH'],HLS:['HLS-S30','HLS-L30','Sentinel-1 koherenssi','Sentinel-1 VH'],PS:['PlanetScope','Sentinel-1 koherenssi','Sentinel-1 VH']}[base.key]||C.SOURCES;
    var m=C.monitor(obsAll.filter(function(o){return bs.indexOf(o.src)>=0}),q);
    $('rvMain').innerHTML='<div class="light lt-'+m.light+'"><span class="dot" aria-hidden="true"></span><div><strong>'+esc(m.label)+'</strong> · luotettavuus '+esc(m.reliability.toLowerCase())+
      '<div class="small muted">'+esc(base.label)+'</div></div></div><ul class="small">'+m.why.map(function(w){return '<li>'+esc(w)+'</li>'}).join('')+'</ul>'+
      (m.history.length>1?'<p class="small muted" style="margin:4px 0 0">Tulos päivittäin: '+m.history.map(function(h){return fiShort(h.date)+' '+h.light.replace('green','vihreä').replace('yellow','keltainen').replace('red','punainen')}).join(' → ')+'</p>':'');
    // aikajana
    var segs=m.daily, tl='';
    if(segs.length){
      var t0=Date.parse(segs[0].from), t1=Date.parse(segs[segs.length-1].to)+864e5, SC={seurannassa:'var(--line)',katve:'var(--warn)',niitto:'var(--accent)',niitetty:'var(--accent-soft, #cfe8d4)'};
      tl='<div class="tline" role="img" aria-label="Päivittäinen tila">'+segs.map(function(g){var w=(Date.parse(g.to)+864e5-Date.parse(g.from))/(t1-t0)*100;return '<i style="width:'+w.toFixed(2)+'%;background:'+SC[g.state]+'" title="'+fiShort(g.from)+'–'+fiShort(g.to)+' '+g.state+'"></i>'}).join('')+'</div>'+
        '<div class="legend small"><span><i style="background:var(--line)"></i>seurannassa</span><span><i style="background:var(--warn)"></i>katve (yli '+C.DEFAULTS.warnGap+' vrk ilman selkeää kuvaa)</span><span><i style="background:var(--accent)"></i>niitto</span><span><i style="background:var(--accent-soft, #cfe8d4)"></i>niitetty</span></div>';
    }
    $('rvTimeline').innerHTML=tl;
    var head='<thead><tr><th>Lähteet</th><th>Tulos</th><th>Luotettavuus</th><th>Niittoväli</th><th>Vihreä alkaen</th><th>Katvetta</th><th>Kuvia (opt./tutka)</th></tr></thead>';
    $('rvTable').innerHTML=head+'<tbody>'+r.rows.map(function(x){
      return '<tr><td>'+esc(x.label)+'</td><td class="'+LIGHT_CSS[x.light]+'"><span class="ldot lt-'+x.light+'"></span>'+esc(x.status)+'</td><td>'+esc(x.reliability)+'</td>'+
        '<td class="num">'+(x.start?fiShort(x.start)+'–'+fiShort(x.end):'–')+'</td><td class="num">'+(x.firstGreen?fiShort(x.firstGreen):'–')+'</td>'+
        '<td class="num">'+x.katveDays+' vrk</td><td class="num">'+x.nOptical+' / '+x.nRadar+'</td></tr>'}).join('')+'</tbody>';
    $('rvSummary').innerHTML=r.summary?'<ul class="small">'+r.summary.text.map(function(t){return '<li>'+esc(t)+'</li>'}).join('')+'</ul>':'';
    $('rvSignals').innerHTML=m.signals.length?'<ul class="small muted">'+m.signals.map(function(g){return '<li>'+fiShort(g.start)+'–'+fiShort(g.end)+' '+esc(NAME[g.fam]||g.fam)+': '+esc(g.text)+' · luottamus '+fx(g.conf,2)+'</li>'}).join('')+'</ul>':'<p class="small muted">Ei signaaleja.</p>';
    monCache={perustaso:base.key,liikennevalo:m.light,tulos:m.label,luotettavuus:m.reliability,perustelut:m.why,paivittain:m.history,jaksot:m.daily,signaalit:m.signals,rivit:r.rows};
  }

  function drawChart(svg,res,allUsed){
    var W=720,H=280,L=48,R=48,T=28,B=40, used=allUsed||res.used;
    if(!used.length){svg.innerHTML='';return}
    var t=function(d){return Date.parse(d)/864e5};
    var ds=used.map(function(o){return o.date}).sort(), x0=t(ds[0]),x1=t(ds[ds.length-1]); if(x1===x0)x1=x0+1;
    var X=function(d){return L+(t(d)-x0)/(x1-x0)*(W-L-R)}, Y=function(v){return T+(1-Math.max(0,Math.min(1,v)))*(H-T-B)};
    // VH-takaisinsironta (dB) piirretään oikealle asteikolle −30…−10 dB → 0…1.
    var yv=function(o){return o.fam==='S1B'?(o.value+30)/20:o.value};
    var mut=css('--muted'),line=css('--line'),acc=css('--accent');
    var s='';
    [0,0.25,0.5,0.75,1].forEach(function(v){s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+Y(v)+'" y2="'+Y(v)+'" stroke="'+line+'"/><text x="'+(L-8)+'" y="'+(Y(v)+4)+'" text-anchor="end" font-size="13" fill="'+mut+'">'+v.toFixed(2)+'</text>'});
    s+='<text x="'+(L-8)+'" y="'+(T-12)+'" text-anchor="end" font-size="12" fill="'+mut+'">NDVI</text>';
    if(used.some(function(o){return o.fam==='S1'}))s+='<text x="'+(W-R+8)+'" y="'+(T-12)+'" font-size="12" fill="'+css('--violet')+'">koher.</text>';
    if(used.some(function(o){return o.fam==='S1B'})){[-30,-20,-10].forEach(function(v){s+='<text x="'+(W-R+6)+'" y="'+(Y((v+30)/20)+4)+'" font-size="11" fill="'+css('--violet')+'">'+v+'</text>'});s+='<text x="'+(W-R+6)+'" y="'+(T-12)+'" font-size="12" fill="'+css('--violet')+'">VH dB</text>'}
    var rl=res.rule&&res.rule.latest, yr=ds[0].slice(0,4);
    if(rl){var dl=yr+'-'+rl; if(t(dl)>=x0&&t(dl)<=x1){var xd=X(dl); s+='<line x1="'+xd+'" x2="'+xd+'" y1="'+T+'" y2="'+(H-B)+'" stroke="'+css('--bad')+'" stroke-dasharray="4 3"/><text x="'+(xd-4)+'" y="'+(T+12)+'" text-anchor="end" font-size="12" fill="'+css('--bad')+'">'+C.fi(dl).slice(0,-4)+'</text>'}}
    res.events.forEach(function(e){var xa=X(e.start),xb=X(e.end);s+='<rect x="'+xa+'" y="'+T+'" width="'+Math.max(3,xb-xa)+'" height="'+(H-T-B)+'" fill="'+acc+'" fill-opacity="'+(e.accepted?0.16:0.06)+'"><title>'+C.fi(e.start)+'–'+C.fi(e.end)+' luottamus '+e.conf+'</title></rect>'});
    var fams={}; used.forEach(function(o){(fams[o.fam]=fams[o.fam]||[]).push(o)});
    Object.keys(fams).forEach(function(f){
      var c=css(COL[f]), pts=fams[f].map(function(o){return X(o.date)+','+Y(yv(o))}).join(' ');
      s+='<polyline points="'+pts+'" fill="none" stroke="'+c+'" stroke-width="1.5"'+(f==='S1'||f==='S1B'?' stroke-dasharray="4 3"':'')+'/>';
      fams[f].forEach(function(o){s+='<circle cx="'+X(o.date)+'" cy="'+Y(yv(o))+'" r="'+(f==='S1B'?3:4.5)+'" fill="'+c+'"'+(o.conflict?' stroke="'+css('--bad')+'" stroke-width="2"':'')+'><title>'+C.fi(o.date)+' '+esc(o.src)+' '+o.value+(o.id?' · '+esc(o.id):'')+(o.conflict?' · '+esc(o.conflict):'')+'</title></circle>'});
    });
    s+='<text x="'+L+'" y="'+(H-14)+'" font-size="13" fill="'+mut+'">'+C.fi(ds[0])+'</text><text x="'+(W-R)+'" y="'+(H-14)+'" text-anchor="end" font-size="13" fill="'+mut+'">'+C.fi(ds[ds.length-1])+'</text>';
    svg.innerHTML=s;
    svg.setAttribute('aria-label','NDVI-aikasarja '+C.fi(ds[0])+'–'+C.fi(ds[ds.length-1])+(res.best?', tunnistettu niittoväli '+C.fi(res.best.start)+'–'+C.fi(res.best.end):''));
    $('legend').innerHTML=Object.keys(fams).map(function(f){return '<span><i style="background:var('+COL[f]+')"></i>'+NAME[f]+'</span>'}).join('')+'<span><i style="background:var(--accent);opacity:.35;border-radius:2px"></i>tunnistettu niittoväli</span>'+(rl?'<span><i style="background:var(--bad);border-radius:1px;width:3px"></i>määräpäivä</span>':'');
  }

  function updateCode(obs){
    var a=obs.length?obs.map(function(o){return o.date}).sort()[0]:'2026-07-15', b=obs.length?obs.map(function(o){return o.date}).sort().pop():'2026-09-15';
    $('hlsCode').textContent=
'# pip install pystac-client rioxarray  (Earthdata-tunnus: urs.earthdata.nasa.gov)\nfrom pystac_client import Client\ncat = Client.open("https://cmr.earthdata.nasa.gov/stac/LPCLOUD")\nitems = cat.search(\n    collections=["HLSS30_2.0", "HLSL30_2.0"],\n    intersects=lohko,              # lohkon GeoJSON, kutistettu puskurilla\n    datetime="'+a+'/'+b+'",\n).item_collection()\n# NDVI: S30 (B8A-B04)/(B8A+B04), L30 (B05-B04)/(B05+B04)\n# Fmask: hylkää pilvi, varjo, lumi ja korkea aerosoli → kelvolliset %\n# Muuttunut % = osuus pikseleistä, joissa NDVI laski ≥ 0,12 edellisestä\nfor it in items:\n    print(it.id, it.datetime.date())   # it.id = kuvatunniste raporttiin';
    $('planetCode').textContent=
'POST https://api.planet.com/data/v1/quick-search\n{\n  "item_types": ["PSScene"],\n  "filter": {"type": "AndFilter", "config": [\n    {"type": "GeometryFilter", "field_name": "geometry", "config": <lohko>},\n    {"type": "DateRangeFilter", "field_name": "acquired",\n     "config": {"gte": "'+a+'T00:00:00Z", "lte": "'+b+'T23:59:59Z"}},\n    {"type": "RangeFilter", "field_name": "cloud_cover", "config": {"lte": 0.5}}\n  ]}\n}\n# Tilaus: Orders API, ortho_analytic_8b_sr + ortho_udm2, työkalut clip + harmonize\n# Kelvolliset % = UDM2 clear -kaistan osuus lohkolla\n# Kuvatunniste raporttiin = item id';
  }

  $('addRow').addEventListener('click',function(){addRow()});
  $('clear').addEventListener('click',function(){tbody.innerHTML='';exampleOn=false;render()});
  $('example').addEventListener('click',function(){
    tbody.innerHTML='';
    // KEKSITTY esimerkkidata. Tunnisteiden muoto vastaa oikeita, sisältö ei.
    [{date:'2026-07-14',src:'HLS-S30',id:'HLS.S30.T34VEP.2026195T094031.v2.0',value:0.78,valid:96},
     {date:'2026-07-23',src:'HLS-L30',id:'HLS.L30.T34VEP.2026204T093522.v2.0',value:0.80,valid:88},
     {date:'2026-07-29',src:'PlanetScope',id:'20260729_093411_07_24b6',value:0.83,valid:100},
     {date:'2026-08-04',src:'PlanetScope',id:'20260804_094512_21_24a4',value:0.84,valid:97},
     {date:'2026-08-06',src:'HLS-S30',id:'HLS.S30.T34VEP.2026218T094029.v2.0',value:0.55,valid:35},
     {date:'2026-08-11',src:'PlanetScope',id:'20260811_093958_44_24c1',value:0.51,valid:98,changed:96},
     {date:'2026-08-13',src:'HLS-S30',id:'HLS.S30.T34VEP.2026225T094031.v2.0',value:0.50,valid:91,changed:94},
     {date:'2026-08-16',src:'PlanetScope',id:'20260816_094102_12_24a4',value:0.55,valid:99},
     {date:'2026-07-20',src:'Sentinel-1 koherenssi',id:'S1A VH 0714–0726',value:0.21},
     {date:'2026-07-26',src:'Sentinel-1 koherenssi',id:'S1C VH 0720–0726',value:0.19},
     {date:'2026-08-01',src:'Sentinel-1 koherenssi',id:'S1A VH 0726–0801',value:0.20},
     {date:'2026-08-07',src:'Sentinel-1 koherenssi',id:'S1C VH 0801–0807',value:0.22},
     {date:'2026-08-13',src:'Sentinel-1 koherenssi',id:'S1A VH 0807–0813',value:0.52}
    ].forEach(addRow);
    if(!$('lohko').value) $('lohko').value='ESIMERKKI-1';
    exampleOn=true; render();
  });
  $('importCsv').addEventListener('click',function(){
    var lines=$('csv').value.split(/\r?\n/), ok=0, bad=0;
    lines.forEach(function(l){
      if(!l.trim()||l.trim().charAt(0)==='#') return;
      var sep=l.indexOf(';')>=0?';':(l.indexOf('\t')>=0?'\t':',');
      var p=l.split(sep).map(function(s){return s.trim()});
      var f=function(x){if(x==null||x==='')return null;var n=parseFloat(sep===','?x:x.replace(',','.'));return isNaN(n)?null:n};
      if(p.length>=4&&/^\d{4}-\d{2}-\d{2}$/.test(p[0])&&C.SOURCES.indexOf(p[1])>=0&&(f(p[3])!=null||f(p[4])!=null)){addRow({date:p[0],src:p[1],id:p[2],value:f(p[3]),valid:f(p[4]),changed:f(p[5])});ok++}
      else bad++;
    });
    $('csvMsg').textContent=ok+' riviä tuotu'+(bad?', '+bad+' ohitettu (tarkista päivä, lähde ja arvo)':'');
    exampleOn=false; render();
  });
  ['lohko','buffer'].forEach(function(id){$(id).addEventListener('input',render)});
  $('dStart').addEventListener('change',render);
  $('copy').addEventListener('click',function(){
    var o=$('out'); if(!o.value) return;
    var btn=this, done=function(){btn.textContent='Kopioitu ✓';setTimeout(function(){btn.textContent='Kopioi teksti'},1500)};
    var fb=function(){o.select();try{document.execCommand('copy')}catch(e){}done()};
    if(navigator.clipboard) navigator.clipboard.writeText(o.value).then(done,fb); else fb();
  });
  $('dlJson').addEventListener('click',function(){
    if(!current) return;
    var blob=new Blob([JSON.stringify(current,null,2)],{type:'application/json'});
    var a=document.createElement('a'); a.href=URL.createObjectURL(blob);
    a.download='niittoraportti_'+String(current.lohko).replace(/[^\w-]/g,'_')+'.json'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){URL.revokeObjectURL(a.href)},1000);
  });

  // ---------- Datahaku (datahaku.js) ----------
  var fieldState=null, psSel=null, busy=false, ctrl=null, pollTimer=null;
  var geoEl=$('geo'), geoMsg=$('geoMsg');
  var logEl=$('fetchLog'), progEl=$('fetchProg'), stopBtn=$('fetchStop'), fetchBox=$('fetchBox');
  var keyEl=$('plKey'), remEl=$('plRemember'), ordEl=$('psOrderId');
  var psOrderBtn=$('psOrder');

  (function initDates(){
    var d=new Date(), y=d.getMonth()<5?d.getFullYear()-1:d.getFullYear();
    // Jakso jatkuu kuukauden määräpäivän (15.9.) yli, jotta niiton jälkeen saadaan 1–2 selkeää kuvaa.
    var end=y+'-10-15', today=d.toISOString().slice(0,10);
    $('dStart').value=y+'-05-01';
    $('dEnd').value=today<end?today:end;
  })();
  var savedKey=getSess('niitto_plkey'); if(savedKey){keyEl.value=savedKey;remEl.checked=true}
  var savedOrd=getSess('niitto_order'); if(savedOrd){try{ordEl.value=JSON.parse(savedOrd).id||''}catch(e){}}
  remEl.addEventListener('change',function(){setSess('niitto_plkey',remEl.checked&&keyEl.value?keyEl.value:null)});
  keyEl.addEventListener('input',function(){if(remEl.checked)setSess('niitto_plkey',keyEl.value||null)});
  $('toCreds').addEventListener('click',function(e){e.preventDefault();var d=$('tunnukset');d.open=true;d.scrollIntoView({behavior:'smooth',block:'start'})});

  function say(t,cls){fetchBox.hidden=false;var li=document.createElement('li');li.className=cls||'info';li.textContent=t;logEl.appendChild(li);return li}
  function parcelHtml(){
    if(!fieldState) return '';
    var pr=lastParcel||{}, season=seasonYear(), h='';
    var tun=$('lohko').value.trim()||pr.tunnus;
    h+='<div class="small muted">'+(pr.kind==='peruslohko'?'Peruslohko':pr.kind==='piirretty'?'Piirretty rajaus':'Kasvulohko')+'</div>';
    h+='<div class="pid">'+esc(tun||'ei tunnusta')+'</div><dl>';
    h+='<div><dt>Pinta-ala</dt><dd>'+fx(fieldState.areaM2/1e4,2)+' ha</dd></div>';
    if(parcelInfo.kasvi) h+='<div><dt>Kasvi '+(parcelInfo.vuosi||'')+'</dt><dd>'+esc(parcelInfo.kasvi)+'</dd></div>';
    h+='</dl>';
    if(pr.kind==='peruslohko') h+='<p class="note w">Kasvulohkoja ei löytynyt, joten rajaus on koko peruslohko. Tarkista, että se vastaa niitettävää alaa.</p>';
    if(parcelInfo.vuosi&&season&&parcelInfo.vuosi!==season) h+='<p class="note w">Rajaus ja kasvi ovat Ruokaviraston vuoden '+parcelInfo.vuosi+' aineistosta. Vahvistat kauden '+season+' tiedot seuraavassa vaiheessa.</p>';
    return h;
  }
  function updateParcel(){
    var h=parcelHtml(); $('parcelCard').innerHTML=h; $('parcelCard').hidden=!h; $('parcelSide').innerHTML=h;
    $('toStep2').disabled=!fieldState; goStepButtons();
  }
  function goStepButtons(){stepBtns.forEach(function(b){var i=+b.dataset.step;b.disabled=i>maxStep||(i>1&&!fieldState)})}
  function parseGeo(){
    fieldState=null; psSel=null; psOrderBtn.disabled=true; psOrderBtn.textContent='2. Tilaa kuvat';
    var t=geoEl.value.trim(); if(!t){geoMsg.textContent='';updateParcel();return}
    try{
      fieldState=HK.parseField(t);
      geoMsg.textContent='Lohko '+fx(fieldState.areaM2/1e4,2)+' ha · '+(fieldState.sourceEpsg===4326?'WGS84':'EPSG:'+fieldState.sourceEpsg);
      geoMsg.style.color='';
      var pr=fieldState.properties||{}, tun=pr.tunnus||pr.kasvulohko||pr.KASVULOHKOTUNNUS||pr.id||pr.ID;
      var key=fieldState.bbox.map(function(v){return v.toFixed(5)}).join(',');
      if(fieldKey&&key!==fieldKey) clearForNewField();
      fieldKey=key;
      parcelInfo={kasvi:pr.kasvi||pr.KASVIKOODI_SELITE_FI||null,vuosi:pr.vuosi?+pr.vuosi:null,lahde:pr.lahde||null};
      var lo=$('lohko'); if(tun) lo.value=tun;
      if(parcelInfo.kasvi){var m=KT.measureFor(parcelInfo.kasvi); measureSel.value=m&&C.RULES[m]?m:''; $('cropOk').checked=false}
      render();
      if(mapCtl) mapCtl.show({type:'Feature',properties:{},geometry:fieldState.geometry});
    }catch(e){geoMsg.textContent='Rajausta ei voitu lukea: '+e.message;geoMsg.style.color='var(--bad)'}
    updateParcel();
  }
  // Uusi lohko: edellisen lohkon havainnot ja tulos eivät saa jäädä näkyviin.
  function clearForNewField(){
    var had=readObs().length;
    tbody.innerHTML=''; exampleOn=false; addRow(); addRow(); maxStep=Math.min(maxStep,2);
    $('cropOk').checked=false;
    if(had){logEl.innerHTML=''; say('Lohko vaihtui: edellisen lohkon havainnot ja tulos poistettiin. Hae havainnot uudelle lohkolle.','warn')}
  }
  geoEl.addEventListener('input',function(){lastParcel=null;parseGeo()});
  $('geoFile').addEventListener('change',function(){
    var f=this.files&&this.files[0]; if(!f) return;
    var r=new FileReader(); r.onload=function(){geoEl.value=String(r.result);lastParcel=null;parseGeo()}; r.readAsText(f);
  });

  // ---------- Lohkon valinta: tunnus, paikka, sijainti ja kartta (kartta.js) ----------
  var mapCtl=null;
  var pickMsg=$('pickMsg'), pltList=$('pltList'), placeList=$('placeList');
  function pickSay(t,cls){pickMsg.textContent=t;pickMsg.style.color=cls==='fail'?'var(--bad)':cls==='warn'?'var(--warn)':''}
  function ensureMap(){
    if(mapCtl){setTimeout(function(){mapCtl.invalidate()},0);return mapCtl}
    try{
      mapCtl=KT.createMap($('map'),{key:mmlKeyEl.value.trim(),layer:baseSel.value,
        year:parseInt(($('dStart').value||'').slice(0,4),10)||new Date().getFullYear(),
        onMessage:function(t,c){pickSay(t,c)}, highlight:$('niittoOn').checked, onSelect:function(p){p.kind='kasvulohko';applyParcel(p)}});
      if(fieldState) mapCtl.show({type:'Feature',properties:{},geometry:fieldState.geometry});
    }catch(e){pickSay('Karttaa ei voitu avata: '+e.message,'fail')}
    return mapCtl;
  }
  function applyParcel(p){
    lastParcel=p;
    geoEl.value=JSON.stringify(p.feature); parseGeo();
    if(p.tunnus) $('lohko').value=p.tunnus;
    if(p.kind==='peruslohko'||p.kind==='piirretty'){ parcelInfo={kasvi:null,vuosi:p.year||null,lahde:p.kind}; }
    render(); updateParcel();
    if(mapCtl) mapCtl.show(p.feature);
    var season=seasonYear(), msg='Valittu '+(p.kind==='peruslohko'?'peruslohko ':'kasvulohko ')+(p.tunnus||'')+(p.kasvi?' · '+p.kasvi:'')+(fieldState?' · '+fx(fieldState.areaM2/1e4,2)+' ha':'')+(p.year?' · Ruokavirasto '+p.year:'')+'.';
    if(p.kind==='peruslohko') msg+=' Kasvulohkoja ei löytynyt, joten rajaus on koko peruslohko. Tarkista, että se vastaa niitettävää alaa.';
    if(p.year&&season&&p.year!==season) msg+=' Huom: rajaus ja kasvi ovat vuoden '+p.year+' aineistosta, arvioitava kausi on '+season+'. Tarkista, että ne ovat samat tänä vuonna.';
    pickSay(msg, p.year&&season&&p.year!==season?'warn':'ok');
  }
  function clearChoices(el){Array.prototype.slice.call(el.querySelectorAll('.choice')).forEach(function(b){b.remove()});el.hidden=true}
  function choice(el,html,fn,pressed){
    var b=document.createElement('button'); b.type='button'; b.className='choice'; b.innerHTML=html;
    if(pressed!=null) b.setAttribute('aria-pressed',pressed?'true':'false');
    b.addEventListener('click',function(){
      Array.prototype.forEach.call(el.querySelectorAll('.choice'),function(x){if(x.hasAttribute('aria-pressed'))x.setAttribute('aria-pressed','false')});
      if(pressed!=null) b.setAttribute('aria-pressed','true');
      fn();
    });
    el.appendChild(b); el.hidden=false;
  }
  var TUNNUS=/^\s*\d{8,10}(\s*-\s*\d{1,3})?\s*$/;
  async function findTunnus(q){
    var y=seasonYear()||new Date().getFullYear();
    var r=await KT.findByTunnus(q,{year:y});
    if(r.parcels.length===1){applyParcel(r.parcels[0]); if(r.kind==='kasvulohko'&&!r.tunnus.lohko) pickMsg.textContent+=' Peruslohkolla on vuoden '+r.year+' aineistossa vain yksi kasvulohko.'; if(r.via==='jsonp') pickMsg.textContent+=' (haettu JSONP:llä)'; if(r.via==='proxy') pickMsg.textContent+=' (haettu välityspalvelimen kautta)'}
    else{
      pickSay('Peruslohkolla on '+r.parcels.length+' kasvulohkoa vuonna '+r.year+'. Valitse niitettävä lohko:');
      r.parcels.sort(function(a,b){return (b.measure?1:0)-(a.measure?1:0)}).forEach(function(p){
        choice(pltList,'<b>'+esc(p.tunnus||'?')+'</b> <span>'+(p.kasvi?'· '+esc(p.kasvi)+' ':'')+'· '+fx(p.ha,2)+' ha</span>'+(p.measure?'<span class="tag">niittovelvoite</span>':''),function(){applyParcel(p)},false);
      });
      if(mapCtl) mapCtl.show({type:'FeatureCollection',features:r.parcels.map(function(p){return p.feature})});
    }
  }
  async function findPlace(q){
    ensureMap(); pickSay('Haetaan paikkaa…');
    var res=await KT.geocode(q, mmlKeyEl.value.trim());
    if(!res.length){pickSay('Paikkaa „'+q+'” ei löytynyt. Tarkista kirjoitusasu tai kirjoita lohkon tunnus.','warn');return}
    var go=function(r){mapCtl.goTo(r.lat,r.lon,15);pickSay(r.label+'. Klikkaa lohkoa kartalla.');$('map').scrollIntoView({block:'nearest'})};
    if(res.length===1){go(res[0]);return}
    pickSay('Valitse paikka:');
    res.forEach(function(r){choice(placeList,'<span>'+esc(r.label.length>80?r.label.slice(0,78)+'…':r.label)+'</span>',function(){clearChoices(placeList);go(r)})});
  }
  $('pltGo').addEventListener('click',async function(){
    var q=$('pltIn').value.trim(); if(!q){$('pltIn').focus();return}
    var btn=this; btn.disabled=true; clearChoices(pltList); clearChoices(placeList);
    try{
      if(TUNNUS.test(q)){pickSay('Haetaan lohkoa…'); await findTunnus(q)}
      else await findPlace(q);
    }catch(e){pickSay(e.message,'fail')}
    btn.disabled=false;
  });
  $('pltIn').addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();$('pltGo').click()}});
  $('locBtn').addEventListener('click',function(){
    if(!navigator.geolocation){pickSay('Selain ei tue sijaintia. Kirjoita lohkon tunnus tai paikka.','warn');return}
    pickSay('Haetaan sijaintia…');
    navigator.geolocation.getCurrentPosition(function(pos){
      var m=ensureMap(); if(!m) return;
      var lat=pos.coords.latitude, lon=pos.coords.longitude;
      m.goTo(lat,lon,16);
      pickSay('Sijainti löytyi (tarkkuus '+Math.round(pos.coords.accuracy)+' m). Haetaan lohkoa kohdasta…');
      m.map.fire('click',{latlng:window.L.latLng(lat,lon)});
    },function(err){pickSay(err.code===1?'Sijainnin käyttö estettiin. Salli sijainti selaimen asetuksista tai kirjoita lohkon tunnus.':'Sijaintia ei saatu. Kirjoita lohkon tunnus tai paikka.','warn')},{enableHighAccuracy:true,timeout:15000,maximumAge:60000});
  });

  var baseSel=$('mapBase'), mmlKeyEl=$('mmlKey'), mmlRem=$('mmlRemember');
  Object.keys(KT.MML_LAYERS).forEach(function(k){var o=document.createElement('option');o.value=k;o.textContent=KT.MML_LAYERS[k].title;baseSel.appendChild(o)});
  var savedMml=getStore('niitto_mmlkey'); if(savedMml){mmlKeyEl.value=savedMml;mmlRem.checked=true}
  function storeMml(){ if(mmlRem.checked&&mmlKeyEl.value) setStore('niitto_mmlkey',mmlKeyEl.value); else { try{localStorage.removeItem('niitto_mmlkey')}catch(e){} } }
  mmlRem.addEventListener('change',storeMml);
  mmlKeyEl.addEventListener('change',function(){storeMml(); if(mapCtl) mapCtl.setKey(mmlKeyEl.value.trim())});
  baseSel.addEventListener('change',function(){ if(mapCtl) mapCtl.setLayer(baseSel.value) });
  $('niittoLegend').innerHTML=KT.NIITTO_CLASSES.map(function(c){return '<span><i style="background:'+c.fill+';opacity:.7"></i>'+esc(c.name)+'</span>'}).join('');
  $('niittoOn').addEventListener('change',function(){ if(mapCtl) mapCtl.setHighlight(this.checked) });
  var drawBtn=$('drawBtn'), drawDone=$('drawDone'), drawCancel=$('drawCancel'), mapHint=$('mapHint');
  function drawUi(on){drawBtn.hidden=on;drawDone.hidden=!on;drawCancel.hidden=!on;mapHint.textContent=on?'Klikkaa lohkon kulmat järjestyksessä ja paina Valmis.':'Lähennä ja klikkaa kasvulohkoa. Rullalla zoomaus toimii, kun olet klikannut karttaa.'}
  drawBtn.addEventListener('click',function(){if(!ensureMap())return;mapCtl.startDraw();drawUi(true)});
  drawCancel.addEventListener('click',function(){mapCtl.stopDraw();drawUi(false)});
  drawDone.addEventListener('click',function(){var f=mapCtl.finishDraw(); if(f){drawUi(false); applyParcel({feature:f,kind:'piirretty',tunnus:null}); parcelInfo={kasvi:null,vuosi:null,lahde:'piirretty'}; render(); updateParcel(); pickSay('Rajaus piirretty käsin'+(fieldState?' · '+fx(fieldState.areaM2/1e4,2)+' ha':'')+'. Lisää kasvulohkon tunnus seuraavassa vaiheessa.','ok')}});

  function fetchOpts(){
    var p=readP();
    return {bufferM:p.bufferM,ndviDrop:p.ndviDrop!=null?p.ndviDrop:C.DEFAULTS.ndviDrop,minValid:p.minValid!=null?p.minValid:C.DEFAULTS.minValid,
      maxCloud:parseFloat($('maxCloud').value)||80,signal:ctrl&&ctrl.signal,
      onProgress:function(m,a,b){if(b){progEl.hidden=false;progEl.max=b;progEl.value=a||0}}};
  }
  function range(){
    var a=$('dStart').value, b=$('dEnd').value;
    if(!a||!b||a>b) throw new Error('Tarkista aikaväli.');
    return [a,b];
  }
  function needField(){ if(!fieldState) throw new Error('Valitse ensin lohko.'); return fieldState }
  function needKey(){ var k=keyEl.value.trim(); if(!k) throw new Error('Syötä Planet-API-avain. Ohjeet: Tunnukset ja ohjeet.'); return k }
  function setBusy(on){
    busy=on; ['runGo','psSearch','psResume'].forEach(function(id){$(id).disabled=on});
    if(!on) $('runGo').disabled=measureSel.isMuu();
    $('runGo').textContent=on?'Haetaan kuvia…':'Hae kuvat ja laske tulos →';
    psOrderBtn.disabled=on||!psSel||!psSel.chosen.length; psOrderBtn.classList.toggle('primary',!psOrderBtn.disabled); stopBtn.hidden=!on&&!pollTimer; if(!on) progEl.hidden=true;
  }
  async function run(fn){
    if(busy) return; ctrl=window.AbortController?new AbortController():null; setBusy(true);
    try{ await fn() }catch(e){ say(e.message,'fail') } finally{ setBusy(false) }
  }
  stopBtn.addEventListener('click',function(){ if(ctrl) ctrl.abort(); if(pollTimer){clearTimeout(pollTimer);pollTimer=null;say('Tilauksen seuranta keskeytettiin. Jatka myöhemmin painikkeella Tarkista ja käsittele.','warn')} stopBtn.hidden=!busy });

  function mergeObs(obs,srcs,label,alsoRemove){
    if(exampleOn){tbody.innerHTML='';exampleOn=false}
    var removed=0, drop=srcs.concat(alsoRemove||[]);
    Array.prototype.slice.call(tbody.querySelectorAll('tr')).forEach(function(tr){
      var s=tr.querySelector('.s').value, empty=!tr.querySelector('.d').value&&tr.querySelector('.v').value==='';
      if(empty||drop.indexOf(s)>=0){ if(!empty&&srcs.indexOf(s)>=0) removed++; tr.remove() }
    });
    obs.forEach(addRow); render();
    say(label+': '+obs.length+' havaintoa lisätty taulukkoon'+(removed?' (aiemmat '+removed+' saman lähteen riviä korvattiin)':'')+'.','ok');
  }
  function sayHidden(list,label){
    if(!list.length) return;
    say(label+': '+list.length+' kuvaa ohitettiin. Ensimmäinen syy: '+list[0],'warn');
  }
  function srcMode(){var r=document.querySelector('input[name="srcMode"]:checked');return r?r.value:'hls'}
  var HLS_SRC=['HLS-S30','HLS-L30'], S2_SRC=['Sentinel-2'];
  async function fetchOne(kind,f,r){
    var label=kind==='hls'?'HLS':'Sentinel-2', fn=kind==='hls'?HK.fetchHls:HK.fetchS2;
    var li=say('Haetaan '+label+'-kuvat '+C.fi(r[0])+'–'+C.fi(r[1])+'…');
    var o=fetchOpts(); var prog=o.onProgress; o.onProgress=function(m,a,b){li.textContent=m;prog(m,a,b)};
    var res=await fn(f,r[0],r[1],o);
    var nv=res.obs.filter(function(o){return o.value!=null}).length, n0=res.obs.length-nv;
    li.textContent=label+': '+res.searched+' kuvaa löytyi, '+nv+' päivältä saatiin lohkolta kelvollinen arvo'+(n0?', '+n0+' päivän kuvissa ei yhtään kelvollista pikseliä (näkyvät pois jätettyinä)':'')+'.';
    sayHidden(res.skipped,label);
    return res.obs;
  }
  // ---------- Sentinel-1 (Copernicus Data Space) ----------
  var cdseId=$('cdseId'), cdseSecret=$('cdseSecret'), cdseRem=$('cdseRemember');
  var sv=getSess('niitto_cdse'); if(sv){try{var o=JSON.parse(sv);cdseId.value=o.id||'';cdseSecret.value=o.secret||'';cdseRem.checked=true;$('s1On').checked=true}catch(e){}}
  function storeCdse(){setSess('niitto_cdse',cdseRem.checked&&cdseId.value&&cdseSecret.value?JSON.stringify({id:cdseId.value,secret:cdseSecret.value}):null)}
  [cdseId,cdseSecret,cdseRem].forEach(function(el){el.addEventListener('change',storeCdse)});
  $('s1On').addEventListener('change',function(){if(this.checked&&(!cdseId.value||!cdseSecret.value)) $('s1Box').open=true});
  async function fetchS1(f,r){
    var li=say('Haetaan Sentinel-1-tutkahavainnot '+C.fi(r[0])+'–'+C.fi(r[1])+'…');
    var o=fetchOpts(); o.onProgress=function(m){li.textContent=m};
    o.proxy=KT.proxyBase&&KT.proxyBase()||null;
    var res=await HK.fetchS1(f,r[0],r[1],{id:cdseId.value.trim(),secret:cdseSecret.value.trim()},o);
    li.textContent='Sentinel-1: '+res.obs.length+' tutkakuvausta (VH-takaisinsironta, nousevat ja laskevat radat).';
    sayHidden(res.skipped,'Sentinel-1');
    return res.obs;
  }
  $('runGo').addEventListener('click',function(){
    if(measureSel.isMuu()) return;
    goStep(3);
    run(async function(){
      var f=needField(), r=range(), mode=srcMode(); logEl.innerHTML='';
      var kinds=mode==='both'?['hls','s2']:[mode], ok=0;
      for(var i=0;i<kinds.length;i++){
        var k=kinds[i];
        try{
          var obs=await fetchOne(k,f,r);
          var mine=k==='hls'?HLS_SRC:S2_SRC, other=mode==='both'?[]:(k==='hls'?S2_SRC:HLS_SRC);
          mergeObs(obs,mine,k==='hls'?'HLS':'Sentinel-2',other); ok++;
        }catch(e){ if(ctrl&&ctrl.signal&&ctrl.signal.aborted) throw e; say(e.message,'fail') }
      }
      if($('s1On').checked){
        try{ var s1=await fetchS1(f,r); mergeObs(s1,['Sentinel-1 VH'],'Sentinel-1'); ok++ }
        catch(e){ if(ctrl&&ctrl.signal&&ctrl.signal.aborted) throw e; say(e.message,'fail') }
      }
      if(ok&&!fetchBox.querySelector('li.fail,li.warn')) setTimeout(function(){if(!busy) fetchBox.hidden=true},4000);
    });
  });

  $('psSearch').addEventListener('click',function(){run(async function(){
    var f=needField(), r=range(), k=needKey(); logEl.innerHTML=''; psSel=null;
    var li=say('Haetaan PlanetScope-kuvalista…');
    psSel=await HK.psSearch(k,f,r[0],r[1],fetchOpts());
    var n=psSel.chosen.length;
    li.textContent='PlanetScope: '+psSel.all+' kuvaa löytyi, '+n+' päivää. Tilattavaksi valitaan kunkin päivän selkein kuva.';
    if(n){
      say('Arvioitu tilattava ala: '+n+' × '+fx(f.areaM2/1e4,2)+' ha ≈ '+fx(psSel.estimateKm2,2)+' km². Tarkista kiintiö ennen tilaamista.','warn');
      psOrderBtn.textContent='2. Tilaa '+n+' kuvaa (≈ '+fx(psSel.estimateKm2,2)+' km²)';
    }
  })});
  psOrderBtn.addEventListener('click',function(){run(async function(){
    var f=needField(), k=needKey();
    if(!psSel||!psSel.chosen.length) throw new Error('Hae ensin kuvalista.');
    var ids=psSel.chosen.map(function(c){return c.id});
    if(!window.confirm('Tilataanko '+ids.length+' PlanetScope-kuvaa lohkoon rajattuna (≈ '+fx(psSel.estimateKm2,2)+' km²)? Tilaus kuluttaa Planet-tilisi kiintiötä.')) return;
    var lo=$('lohko').value.trim();
    var id=await HK.psOrder(k,f,ids,'Niittoraportti '+(lo||'')+' '+new Date().toISOString().slice(0,10));
    ordEl.value=id; setSess('niitto_order',JSON.stringify({id:id,ids:ids}));
    say('Tilaus lähetetty, tunnus '+id+'. Tila tarkistetaan 30 sekunnin välein.','ok');
    psSel=null; psOrderBtn.textContent='2. Tilaa kuvat';
    setTimeout(function(){poll(id,ids)},0);
  })});
  function poll(id,ids){
    if(pollTimer){clearTimeout(pollTimer);pollTimer=null}
    run(async function(){
      var k=needKey(), f=needField();
      var st=await HK.psOrderStatus(k,id);
      if(st.state==='success'||st.state==='partial'){
        say('Tilaus '+id+' valmis ('+st.state+'). Lasketaan havainnot…');
        var res=await HK.psProcess(st.results,f,ids||[],fetchOpts());
        sayHidden(res.skipped,'PlanetScope');
        mergeObs(res.obs,['PlanetScope'],'PlanetScope');
        if(st.state==='partial') say('Osa tilauksen kuvista epäonnistui Planetin päässä.','warn');
      }else if(st.state==='failed'||st.state==='cancelled'){
        throw new Error('Tilaus '+id+' päättyi tilaan '+st.state+'. '+(st.message||''));
      }else{
        var li=logEl.querySelector('li[data-poll]')||say(''); li.setAttribute('data-poll','1');
        li.textContent='Tilaus '+id+': '+st.state+' ('+new Date().toLocaleTimeString('fi-FI')+'). Seuraava tarkistus 30 s kuluttua.';
        pollTimer=setTimeout(function(){pollTimer=null;poll(id,ids)},30000);
      }
    });
  }
  $('psResume').addEventListener('click',function(){
    var id=ordEl.value.trim(); if(!id){say('Syötä tilauksen tunnus.','fail');return}
    var ids=null; try{var s=JSON.parse(getSess('niitto_order')||'null'); if(s&&s.id===id) ids=s.ids}catch(e){}
    poll(id,ids);
  });

  addRow(); addRow(); render(); updateParcel();
  var h0=location.hash&&location.hash.slice(1);
  if(h0&&$(h0)&&$(h0).classList.contains('panel')) show(h0); else show('tyokalu');
  goStep(1,true);
})();
