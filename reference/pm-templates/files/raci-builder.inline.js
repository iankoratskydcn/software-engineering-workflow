
(function(){
  var root=document.getElementById('pmn-raci');
  if(!root) return;
  var KEY='pmn-raci-v1';
  var ORDER=['','R','A','C','I','A/R','A/C','C/I'];
  var NAMES={'R':'Responsible','A':'Accountable','C':'Consulted','I':'Informed','A/R':'Accountable and Responsible','A/C':'Accountable and Consulted','C/I':'Consulted and Informed'};
  var table=root.querySelector('.pmnr-table');
  var summary=root.querySelector('.pmnr-summary');
  var brush='cycle';

  function example(){
    return {roles:['Project Sponsor','Project Manager','Business Analyst','Technical Lead','Developers'],
      tasks:[
        {name:'Approve project charter',v:['A','R','C','I','I']},
        {name:'Gather business requirements',v:['I','A','R','C','I']},
        {name:'Design technical solution',v:['I','A','C','R','C']},
        {name:'Build and unit test',v:['','A','I','C','R']},
        {name:'User acceptance sign-off',v:['A','A','R','I','I']}
      ]};
  }
  function blank(){
    return {roles:['Role 1','Role 2','Role 3'],
      tasks:[{name:'Task 1',v:['','','']},{name:'Task 2',v:['','','']},{name:'Task 3',v:['','','']}]};
  }
  function valid(s){
    if(!s||!Array.isArray(s.roles)||!Array.isArray(s.tasks)||!s.roles.length) return false;
    return s.tasks.every(function(t){return t&&typeof t.name==='string'&&Array.isArray(t.v)&&t.v.length===s.roles.length;});
  }
  function load(){
    try{var s=JSON.parse(localStorage.getItem(KEY));if(valid(s)) return s;}catch(e){}
    return example();
  }
  function save(){try{localStorage.setItem(KEY,JSON.stringify(state));}catch(e){}}
  var state=load();
  function rolesDown(){return state.layout==='down';}
  function showCheck(){return !state.hideCheck;}

  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/[<]/g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function issues(t){
    var a=0,r=0,out=[];
    t.v.forEach(function(x){if(x==='A'||x==='A/R'||x==='A/C')a++;if(x==='R'||x==='A/R')r++;});
    if(!r) out.push('No one is Responsible');
    if(!a) out.push('No one is Accountable');
    if(a>1) out.push(a+' people are Accountable, keep one');
    return out;
  }
  function checkText(t){var i=issues(t);return i.length?i.join('. '):'OK';}
  function roleUsed(i){return state.tasks.some(function(t){return t.v[i];});}

  function vertical(){return state.names==='vertical';}
  function vHead(attr,name,delAttr,canDel,label,dot){
    var v='\x3Cdiv class="pmnr-vhead">';
    if(dot) v+='\x3Cspan class="pmnr-dot" title="Not assigned to any task">\x3Cspan class="pmnr-sr">Not assigned to any task\x3C/span>\x3C/span>';
    v+='\x3Cspan class="pmnr-vtext" contenteditable="true" role="textbox" spellcheck="false" aria-label="'+label+' name" '+attr+'>'+esc(name)+'\x3C/span>';
    if(canDel) v+='\x3Cbutton type="button" class="pmnr-del" '+delAttr+' aria-label="Remove '+label.toLowerCase()+' '+esc(name)+'">&times;\x3C/button>';
    return v+'\x3C/div>';
  }
  function roleHead(r,i,unusedHere){
    if(vertical()&&!rolesDown()) return vHead('data-role="'+i+'"',r,'data-del-role="'+i+'"',state.roles.length>1,'Role',showCheck()&&!roleUsed(i));
    var h='\x3Cdiv class="pmnr-field">\x3Cinput type="text" data-role="'+i+'" value="'+esc(r)+'" aria-label="Role name">';
    if(state.roles.length>1) h+='\x3Cbutton type="button" class="pmnr-del" data-del-role="'+i+'" aria-label="Remove role '+esc(r)+'">&times;\x3C/button>';
    return h+'\x3C/div>'+(unusedHere&&showCheck()&&!roleUsed(i)?'\x3Cspan class="pmnr-unused">Not assigned to any task\x3C/span>':'');
  }
  function taskHead(t,ri){
    if(vertical()&&rolesDown()) return vHead('data-task="'+ri+'"',t.name,'data-del-task="'+ri+'"',state.tasks.length>1,'Task',false);
    var h='\x3Cdiv class="pmnr-field">\x3Cinput type="text" data-task="'+ri+'" value="'+esc(t.name)+'" aria-label="Task name">';
    if(state.tasks.length>1) h+='\x3Cbutton type="button" class="pmnr-del" data-del-task="'+ri+'" aria-label="Remove task '+esc(t.name)+'">&times;\x3C/button>';
    return h+'\x3C/div>';
  }
  function cellBtn(ri,ci){
    var t=state.tasks[ri],v=t.v[ci];
    return '\x3Ctd>\x3Cbutton type="button" class="pmnr-cell" data-r="'+ri+'" data-c="'+ci+'" data-v="'+esc(v)+'" aria-label="'+esc(t.name)+', '+esc(state.roles[ci])+': '+(NAMES[v]||'not assigned')+'">'+(v?esc(v):'&middot;')+'\x3C/button>\x3C/td>';
  }
  function statusCell(t){
    var iss=issues(t);
    return '\x3Ctd class="pmnr-status '+(iss.length?'is-bad':'is-ok')+'">'+(iss.length?esc(iss.join('. ')):'&#10003; Looks good')+'\x3C/td>';
  }

  function render(){
    var h,ok=0;
    state.tasks.forEach(function(t){if(!issues(t).length) ok++;});
    if(!rolesDown()){
      h='\x3Cthead>\x3Ctr>\x3Cth class="pmnr-corner" scope="col">Task\x3C/th>';
      state.roles.forEach(function(r,i){h+='\x3Cth scope="col"'+(vertical()?' class="pmnr-vert"':'')+'>'+roleHead(r,i,true)+'\x3C/th>';});
      h+=(showCheck()?'\x3Cth class="pmnr-check-h" scope="col">Check\x3C/th>':'')+'\x3C/tr>\x3C/thead>\x3Ctbody>';
      state.tasks.forEach(function(t,ri){
        h+='\x3Ctr>\x3Cth scope="row">'+taskHead(t,ri)+'\x3C/th>';
        t.v.forEach(function(v,ci){h+=cellBtn(ri,ci);});
        h+=(showCheck()?statusCell(t):'')+'\x3C/tr>';
      });
    } else {
      h='\x3Cthead>\x3Ctr>\x3Cth class="pmnr-corner" scope="col">Role\x3C/th>';
      state.tasks.forEach(function(t,ri){h+='\x3Cth scope="col"'+(vertical()?' class="pmnr-vert"':'')+'>'+taskHead(t,ri)+'\x3C/th>';});
      h+='\x3C/tr>\x3C/thead>\x3Ctbody>';
      state.roles.forEach(function(r,ci){
        h+='\x3Ctr>\x3Cth scope="row">'+roleHead(r,ci,true)+'\x3C/th>';
        state.tasks.forEach(function(t,ri){h+=cellBtn(ri,ci);});
        h+='\x3C/tr>';
      });
      if(showCheck()){
        h+='\x3Ctr>\x3Cth scope="row" class="pmnr-check-h">Check\x3C/th>';
        state.tasks.forEach(function(t){h+=statusCell(t);});
        h+='\x3C/tr>';
      }
    }
    table.innerHTML=h+'\x3C/tbody>';
    table.classList.toggle('is-down',rolesDown());
    table.classList.toggle('has-vert',vertical());
    var n=state.tasks.length;
    summary.hidden=!showCheck();
    root.querySelector('.pmnr-hide-check').checked=!showCheck();
    summary.className='pmnr-summary '+(ok===n?'is-ok':'is-bad');
    summary.textContent=ok===n
      ? 'All '+n+' tasks pass: each has one Accountable person and at least one Responsible.'
      : ok+' of '+n+' tasks pass the check. Fix the ones flagged in red.';
    root.querySelectorAll('[data-names]').forEach(function(x){
      x.setAttribute('aria-pressed',(x.dataset.names==='vertical')===(state.names==='vertical')?'true':'false');
    });
    root.querySelectorAll('[data-layout]').forEach(function(x){x.setAttribute('aria-pressed',(x.dataset.layout==='down')===rolesDown()?'true':'false');});
  }

  function focusCell(r,c){
    var b=table.querySelector('.pmnr-cell[data-r="'+r+'"][data-c="'+c+'"]');
    if(b) b.focus();
  }
  function setCell(r,c,v){state.tasks[r].v[c]=v;save();render();focusCell(r,c);}

  table.addEventListener('click',function(e){
    var cell=e.target.closest('.pmnr-cell');
    if(cell){
      var r=+cell.dataset.r,c=+cell.dataset.c,cur=state.tasks[r].v[c];
      var next=brush==='cycle'?ORDER[(ORDER.indexOf(cur)+1)%ORDER.length]:brush;
      setCell(r,c,next);return;
    }
    var dr=e.target.closest('[data-del-role]');
    if(dr){var i=+dr.dataset.delRole;state.roles.splice(i,1);state.tasks.forEach(function(t){t.v.splice(i,1);});save();render();return;}
    var dt=e.target.closest('[data-del-task]');
    if(dt){state.tasks.splice(+dt.dataset.delTask,1);save();render();}
  });

  table.addEventListener('input',function(e){
    var el=e.target;
    var val=el.isContentEditable?el.textContent:el.value;
    if(el.dataset.role!==undefined) state.roles[+el.dataset.role]=val;
    if(el.dataset.task!==undefined) state.tasks[+el.dataset.task].name=val;
    save();
  });
  table.addEventListener('change',function(e){if(e.target.tagName==='INPUT') render();});
  table.addEventListener('focusout',function(e){if(e.target.isContentEditable) render();});
  table.addEventListener('paste',function(e){
    if(!e.target.isContentEditable) return;
    e.preventDefault();
    var txt=(e.clipboardData||window.clipboardData).getData('text').replace(/\s+/g,' ');
    document.execCommand('insertText',false,txt);
  });

  table.addEventListener('keydown',function(e){
    if(e.target.isContentEditable&&e.key==='Enter'){e.preventDefault();e.target.blur();return;}
    var cell=e.target.closest('.pmnr-cell');
    if(!cell) return;
    var r=+cell.dataset.r,c=+cell.dataset.c,k=e.key.toUpperCase();
    var map={'R':'R','A':'A','C':'C','I':'I'};
    if(map[k]){e.preventDefault();setCell(r,c,map[k]);return;}
    if(k==='DELETE'||k==='BACKSPACE'){e.preventDefault();setCell(r,c,'');return;}
    var moves=rolesDown()
      ? {'ARROWUP':[0,-1],'ARROWDOWN':[0,1],'ARROWLEFT':[-1,0],'ARROWRIGHT':[1,0]}
      : {'ARROWUP':[-1,0],'ARROWDOWN':[1,0],'ARROWLEFT':[0,-1],'ARROWRIGHT':[0,1]};
    if(moves[k]){e.preventDefault();focusCell(r+moves[k][0],c+moves[k][1]);}
  });

  root.querySelector('.pmnr-brush').addEventListener('click',function(e){
    var b=e.target.closest('[data-brush]');
    if(!b) return;
    brush=b.dataset.brush;
    root.querySelectorAll('[data-brush]').forEach(function(x){x.setAttribute('aria-pressed',x===b?'true':'false');});
  });
  root.querySelector('.pmnr-names').addEventListener('click',function(e){
    var b=e.target.closest('[data-names]');
    if(!b||b.disabled) return;
    state.names=b.dataset.names;save();render();
  });
  root.querySelector('.pmnr-hide-check').addEventListener('change',function(e){state.hideCheck=e.target.checked;save();render();});
  root.querySelector('.pmnr-layout').addEventListener('click',function(e){
    var b=e.target.closest('[data-layout]');
    if(!b) return;
    state.layout=b.dataset.layout;save();render();
  });

  /* Grid in the orientation currently shown, for exports */
  function grid(){
    var checks=state.tasks.map(checkText),show=showCheck();
    if(!rolesDown()) return {corner:'Task',cols:state.roles.slice(),
      rows:state.tasks.map(function(t,i){return {name:t.name,v:t.v.slice(),check:checks[i]};}),checkRow:null,show:show};
    return {corner:'Role',cols:state.tasks.map(function(t){return t.name;}),
      rows:state.roles.map(function(r,i){return {name:r,v:state.tasks.map(function(t){return t.v[i];})};}),checkRow:checks,show:show};
  }

  function download(content,type,name){
    var url=URL.createObjectURL(content instanceof Blob?content:new Blob([content],{type:type}));
    var a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();
    setTimeout(function(){URL.revokeObjectURL(url);},1000);
  }
  function toCSV(){
    function q(s){return '"'+String(s).replace(/"/g,'""')+'"';}
    var g=grid(),col=!g.checkRow;
    var rows=[[g.corner].concat(g.cols).concat(col&&g.show?['Check']:[])];
    g.rows.forEach(function(r){rows.push([r.name].concat(r.v).concat(col&&g.show?[r.check]:[]));});
    if(!col&&g.show) rows.push(['Check'].concat(g.checkRow));
    return '\ufeff'+rows.map(function(r){return r.map(q).join(',');}).join('\r\n');
  }

  var FILL={'R':['#f28c28','#2b1400'],'A':['#1f3a5f','#ffffff'],'A/R':['#1f3a5f','#ffffff'],'A/C':['#1f3a5f','#ffffff'],'C/I':['#9cc8e8','#0f2742'],'C':['#9cc8e8','#0f2742'],'I':['#e8eef4','#3d5166']};
  function exportTable(cell,vcss){
    var g=grid(),col=!g.checkRow,vert=vertical()&&!!vcss;
    function chk(txt){return '\x3Ctd style="'+cell+'text-align:left;font-size:9pt;color:'+(txt==='OK'?'#23704a':'#b3261e')+'">'+esc(txt)+'\x3C/td>';}
    var h='\x3Ctable style="border-collapse:collapse;width:100%">\x3Cthead>\x3Ctr>';
    h+='\x3Cth style="'+cell+'background:#142842;color:#ffffff;text-align:left">'+g.corner+'\x3C/th>';
    g.cols.forEach(function(c){h+=vert?vcss(c,cell):'\x3Cth style="'+cell+'background:#1f3a5f;color:#ffffff">'+esc(c)+'\x3C/th>';});
    if(col&&g.show) h+='\x3Cth style="'+cell+'background:#e8eef4;color:#1f3a5f">Check\x3C/th>';
    h+='\x3C/tr>\x3C/thead>\x3Ctbody>';
    g.rows.forEach(function(r){
      h+='\x3Ctr>\x3Ctd style="'+cell+'text-align:left;font-weight:bold">'+esc(r.name)+'\x3C/td>';
      r.v.forEach(function(v){var f=FILL[v];h+='\x3Ctd style="'+cell+'font-weight:bold;'+(f?'background:'+f[0]+';color:'+f[1]+';':'')+'">'+esc(v)+'\x3C/td>';});
      if(col&&g.show) h+=chk(r.check);
      h+='\x3C/tr>';
    });
    if(!col&&g.show){
      h+='\x3Ctr>\x3Ctd style="'+cell+'text-align:left;font-weight:bold;background:#e8eef4;color:#1f3a5f">Check\x3C/td>';
      g.checkRow.forEach(function(c){h+=chk(c);});
      h+='\x3C/tr>';
    }
    return h+'\x3C/tbody>\x3C/table>';
  }
  var LEGEND='\x3Cp style="font-family:Arial,sans-serif;font-size:9pt;color:#5a6b7d;margin-top:12pt">'
    +'\x3Cb>R\x3C/b> Responsible: does the work. \x3Cb>A\x3C/b> Accountable: owns the outcome, one per task. '
    +'\x3Cb>C\x3C/b> Consulted: gives input. \x3Cb>I\x3C/b> Informed: receives updates.\x3C/p>'
    +'\x3Cp style="font-family:Arial,sans-serif;font-size:8pt;color:#8a99a8">Made with the free RACI builder at projectmanagers.net\x3C/p>';

  function wordDoc(){
    var cell='border:1px solid #c9d4df;padding:6pt;font-family:Arial,sans-serif;font-size:10pt;text-align:center;vertical-align:middle;';
    var doc='\x3Chtml xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">'
      +'\x3Chead>\x3Cmeta charset="utf-8">\x3Ctitle>RACI matrix\x3C/title>'
      +'\x3Cstyle>@page Section1{size:11in 8.5in;mso-page-orientation:landscape;margin:0.7in}div.Section1{page:Section1}\x3C/style>\x3C/head>'
      +'\x3Cbody>\x3Cdiv class="Section1">\x3Ch1 style="font-family:Arial,sans-serif;font-size:16pt;color:#1f3a5f">RACI matrix\x3C/h1>'+exportTable(cell,null)+LEGEND+'\x3C/div>\x3C/body>\x3C/html>';
    download('\ufeff'+doc,'application/msword','raci-matrix.doc');
  }
  function printMatrix(){
    var cell='border:1px solid #c9d4df;padding:8px;font-size:12px;text-align:center;vertical-align:middle;';
    var w=window.open('','_blank');
    if(!w){alert('Allow pop-ups for this site to print your matrix.');return;}
    w.document.write('\x3C!doctype html>\x3Chtml>\x3Chead>\x3Cmeta charset="utf-8">\x3Ctitle>RACI matrix\x3C/title>\x3Cstyle>@page{size:landscape}body{font-family:Arial,Helvetica,sans-serif;margin:24px;color:#1d2733;-webkit-print-color-adjust:exact;print-color-adjust:exact}h1{font-size:20px;color:#1f3a5f}\x3C/style>\x3C/head>\x3Cbody>\x3Ch1>RACI matrix\x3C/h1>'+exportTable(cell,function(c,base){return '\x3Cth style="'+base+'background:#1f3a5f;color:#ffffff;vertical-align:bottom;width:40px">\x3Cspan style="writing-mode:vertical-rl;transform:rotate(180deg);display:inline-block;white-space:nowrap">'+esc(c)+'\x3C/span>\x3C/th>';})+LEGEND+'\x3C/body>\x3C/html>');
    w.document.close();w.focus();
    setTimeout(function(){w.print();},250);
  }

  root.querySelector('.pmnr-actions').addEventListener('click',function(e){
    var b=e.target.closest('[data-act]');
    if(!b) return;
    var act=b.dataset.act;
    if(act==='add-task'){
      state.tasks.push({name:'New task',v:state.roles.map(function(){return '';})});
      save();render();
      var ins=table.querySelectorAll('input[data-task]');ins[ins.length-1].select();
    } else if(act==='add-role'){
      state.roles.push('New role');state.tasks.forEach(function(t){t.v.push('');});
      save();render();
      var rs=table.querySelectorAll('input[data-role]');rs[rs.length-1].select();
    } else if(act==='csv'){
      download(toCSV(),'text/csv;charset=utf-8','raci-matrix.csv');
    } else if(act==='word'){
      wordDoc();
    } else if(act==='print'){
      printMatrix();
    } else if(act==='example'||act==='blank'){
      if(!confirm('This replaces your current matrix. Continue?')) return;
      var layout=state.layout,names=state.names,hc=state.hideCheck;
      state=act==='example'?example():blank();state.layout=layout;state.names=names;state.hideCheck=hc;save();render();
    }
  });

  try{render();}catch(err){summary.textContent='The matrix could not load: '+err.message;throw err;}
})();
