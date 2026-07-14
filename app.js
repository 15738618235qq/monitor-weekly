// ==================== CORE DATA MODEL ====================
window.__APP_LOADED__ = false;
window.__APP_ERROR__ = null;
try {
const APP_KEY='monitorData_v5';
const USER_KEY='monitorUser_v5';
const VERSIONS_KEY='monitorVersions_v5';
const LOG_KEY='monitorLogs_v5';
const SYNC_CONFIG_KEY='monitorSyncConfig_v5';
const PENDING_SYNC_KEY='monitorPendingSync_v5';

// Supabase Cloud Sync Config
const SUPABASE_URL='https://sakehlndzmwasqpavzxy.supabase.co';
const SUPABASE_ANON_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNha2VobG5kem13YXNxcGF2enh5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0NjI1NjgsImV4cCI6MjA5ODAzODU2OH0.PjR4cHMot8anj5tmHwze4WEsgDmvXyNhUZiSBGqh04U';
let supabase=null,cloudUser=null,supabaseConnected=false;
let pendingSyncQueue=[],realtimeChannel=null,onlineUserCount=0;

function initSupabase(){
  if(supabase)return; // 防止重复初始化
  // CDN 可能仍在异步加载后备脚本，若 window.supabase 尚未就绪则延迟重试
  if(!window.supabase||!window.supabase.createClient){
    console.warn('[Supabase] SDK 尚未就绪，1s 后重试...');
    setTimeout(initSupabase,1000);
    return;
  }
  try{
    const config=JSON.parse(localStorage.getItem(SYNC_CONFIG_KEY)||'{}');
    const url=SUPABASE_URL;
    const key=SUPABASE_ANON_KEY;
    if(url.includes('YOUR_PROJECT')||key.includes('YOUR_ANON_KEY')){
      supabase=null;supabaseConnected=false;updateSyncUI();return;
    }
    supabase=window.supabase.createClient(url,key,{
      auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false},
      realtime:{params:{eventsPerSecond:10}}
    });
    supabaseConnected=true;
    updateSyncUI();
    // 监听认证状态变化，实现登录持久化
    supabase.auth.onAuthStateChange(function(event,session){
      console.log('[Supabase] Auth state:',event,session?session.user?.email:'no session');
      if(session){cloudUser=session.user;supabaseConnected=true;}
      else if(event==='SIGNED_OUT'){cloudUser=null;}
      updateSyncUI();
      // INITIAL_SESSION 表示页面刷新后从 localStorage 恢复了会话
      if(event==='SIGNED_IN'||event==='INITIAL_SESSION'){
        addOperationLog('云同步','已恢复云端会话');
        setTimeout(function(){syncFromCloud();},500);
      }
    });
    loadCloudUser();
    startRealtimeSubscription();
    setInterval(pollRealTime,5000);
    setInterval(flushPendingSync,30000);
  }catch(e){
    console.error('[Supabase] 初始化失败:',e);
    supabase=null;supabaseConnected=false;
    updateSyncUI();
  }
}

function updateSyncUI(){
  const dot=document.getElementById('cloudStatusMini');
  if(supabaseConnected&&cloudUser){
    dot.innerHTML='<span class="sync-status-dot connected"></span>已连接 · '+(cloudUser.email||'云端用户');
  }
  else if(supabaseConnected){dot.innerHTML='<span class="sync-status-dot connected"></span>已连接(未登录)';}
  else{dot.innerHTML='<span class="sync-status-dot disconnected"></span>未连接';}
  const st=document.getElementById('syncStatusText');
  if(st){
    if(supabaseConnected&&cloudUser){st.innerHTML='<span class="sync-status-dot connected"></span>已连接 · '+(cloudUser.email||'云端用户');}
    else if(supabaseConnected){st.innerHTML='<span class="sync-status-dot connected"></span>已连接(未登录云端)';}
    else{st.innerHTML='<span class="sync-status-dot disconnected"></span>未连接';}
  }
  // 侧边栏底部用户区域
  const su=document.getElementById('sidebarUser');
  const ud=document.getElementById('userDot');
  if(cloudUser){
    if(su)su.textContent=cloudUser.email||'云端用户';
    if(ud)ud.classList.remove('offline');
  }
  const oc=document.getElementById('syncOnlineCount');
  if(oc)oc.textContent=onlineUserCount||'-';
  const pc=document.getElementById('syncPendingCount');
  if(pc)pc.textContent=pendingSyncQueue.length;
  const si=document.getElementById('sidebarStorageInfo');
  if(si)si.innerHTML=supabaseConnected&&cloudUser?'本地存储 + 云同步'+(pendingSyncQueue.length>0?'<span class="pending-badge">'+pendingSyncQueue.length+'</span>':''):'数据存储在浏览器本地';
  const bl=document.getElementById('btnCloudLogin');
  const blo=document.getElementById('btnCloudLogout');
  const cud=document.getElementById('cloudUserDisplay');
  if(cloudUser){
    if(bl)bl.style.display='none';
    if(blo)blo.style.display='inline-flex';
    if(cud)cud.textContent=cloudUser.email||'云端用户';
  }else{
    if(bl)bl.style.display='inline-flex';
    if(blo)blo.style.display='none';
  }
}

function loadCloudUser(){
  if(!supabase)return;
  supabase.auth.getSession().then(function(r){
    if(r.data&&r.data.session){cloudUser=r.data.session.user;supabaseConnected=true;}
    updateSyncUI();
  }).catch(function(){cloudUser=null;updateSyncUI();});
}

async function cloudSignUp(){
  if(!supabase){toast('请先配置Supabase','error');return;}
  var e=document.getElementById('cloudEmail').value.trim();
  var p=document.getElementById('cloudPass').value.trim();
  var m=document.getElementById('cloudAuthMsg');
  if(!e||!p||p.length<6){m.textContent='请输入有效邮箱和至少6位密码';m.style.color='#c5221f';return;}
  try{
    var r=await supabase.auth.signUp({email:e,password:p});
    if(r.error){m.textContent='注册失败: '+r.error.message;m.style.color='#c5221f';return;}
    cloudUser=r.data.user;
    m.textContent='注册成功！已自动登录';m.style.color='#137333';
    updateSyncUI();addOperationLog('云同步','Supabase云端注册');
    setTimeout(function(){syncToCloud();},1000);
  }catch(ex){m.textContent='连接错误: '+ex.message;m.style.color='#c5221f';}
}

async function cloudSignIn(){
  if(!supabase){toast('请先配置Supabase','error');return;}
  var e=document.getElementById('cloudEmail').value.trim();
  var p=document.getElementById('cloudPass').value.trim();
  var m=document.getElementById('cloudAuthMsg');
  if(!e||!p){m.textContent='请输入邮箱和密码';m.style.color='#c5221f';return;}
  try{
    var r=await supabase.auth.signInWithPassword({email:e,password:p});
    if(r.error){m.textContent='登录失败: '+r.error.message;m.style.color='#c5221f';return;}
    cloudUser=r.data.user;
    m.textContent='登录成功';m.style.color='#137333';
    updateSyncUI();addOperationLog('云同步','Supabase云端登录');
    setTimeout(function(){syncFromCloud();},1000);
  }catch(ex){m.textContent='连接错误: '+ex.message;m.style.color='#c5221f';}
}

async function cloudLogout(){
  if(supabase)await supabase.auth.signOut().catch(function(){});
  cloudUser=null;updateSyncUI();
  var m=document.getElementById('cloudAuthMsg');
  if(m){m.textContent='已退出云端登录';m.style.color='#555';}
  addOperationLog('云同步','退出Supabase云端');
}

function showCloudAuthModal(){
  $('cloudAuthModal').classList.add('show');
}

function syncLocalUserFromCloud(){
  if(!cloudUser)return;
  currentUser={name:cloudUser.email,passHash:'',cloudId:cloudUser.id,created:cloudUser.created_at||new Date().toISOString()};
  localStorage.setItem(USER_KEY,JSON.stringify(currentUser));
  $('loginOverlay').style.display='none';
  initApp();
}

async function cloudSignUpFromModal(){
  if(!supabase){var m=document.getElementById('cloudAuthMsgModal');m.textContent='请等待Supabase初始化完成';m.style.color='#c5221f';return;}
  var e=document.getElementById('cloudEmailModal').value.trim();
  var p=document.getElementById('cloudPassModal').value.trim();
  var m=document.getElementById('cloudAuthMsgModal');
  if(!e||!p||p.length<6){m.textContent='请输入有效邮箱和至少6位密码';m.style.color='#c5221f';return;}
  try{
    var r=await supabase.auth.signUp({email:e,password:p});
    if(r.error){m.textContent='注册失败: '+r.error.message;m.style.color='#c5221f';return;}
    cloudUser=r.data.user;
    m.textContent='注册成功！已自动登录';m.style.color='#137333';
    updateSyncUI();addOperationLog('云同步','Supabase云端注册');
    syncLocalUserFromCloud();
    setTimeout(function(){$('cloudAuthModal').classList.remove('show');syncToCloud();},1000);
  }catch(ex){m.textContent='连接错误: '+ex.message;m.style.color='#c5221f';}
}

async function cloudSignInFromModal(){
  if(!supabase){var m=document.getElementById('cloudAuthMsgModal');m.textContent='请等待Supabase初始化完成';m.style.color='#c5221f';return;}
  var e=document.getElementById('cloudEmailModal').value.trim();
  var p=document.getElementById('cloudPassModal').value.trim();
  var m=document.getElementById('cloudAuthMsgModal');
  if(!e||!p){m.textContent='请输入邮箱和密码';m.style.color='#c5221f';return;}
  try{
    var r=await supabase.auth.signInWithPassword({email:e,password:p});
    if(r.error){m.textContent='登录失败: '+r.error.message;m.style.color='#c5221f';return;}
    cloudUser=r.data.user;
    m.textContent='登录成功';m.style.color='#137333';
    updateSyncUI();addOperationLog('云同步','Supabase云端登录');
    syncLocalUserFromCloud();
    setTimeout(function(){$('cloudAuthModal').classList.remove('show');syncFromCloud();},1000);
  }catch(ex){m.textContent='连接错误: '+ex.message;m.style.color='#c5221f';}
}

function startRealtimeSubscription(){
  if(!supabase||!supabaseConnected)return;
  try{
    if(realtimeChannel)realtimeChannel.unsubscribe();
    realtimeChannel=supabase.channel('m_changes')
      .on('postgres_changes',{event:'*',schema:'public',table:'measurements'},function(payload){
        var isSelf=(cloudUser&&payload.new&&payload.new.uploaded_by===cloudUser.email);
        if(!isSelf&&(payload.eventType==='INSERT'||payload.eventType==='UPDATE')){
          toast('检测到其他用户修改了数据，正在合并...','info');
          setTimeout(function(){syncFromCloud();},300);
        }
      }).subscribe(function(status){
        if(status==='SUBSCRIBED')console.log('Realtime OK');
      });
  }catch(e){console.warn('Realtime失败: '+e.message);}
}

async function pollRealTime(){
  if(!supabaseConnected||!cloudUser)return;
  try{
    var r=await supabase.from('measurements').select('uploaded_by').limit(100);
    if(!r.error&&r.data)onlineUserCount=new Set(r.data.map(function(x){return x.uploaded_by;}).filter(Boolean)).size;
  }catch(e){onlineUserCount=0;}
  updateSyncUI();
}

// Dual-write saveData
var _originalSaveData=saveData;
saveData=function(data){
  data._lastSaved=new Date().toISOString();
  data._savedBy=(currentUser?currentUser.name:'unknown');
  data._version=5.2;
  try{localStorage.setItem(APP_KEY,JSON.stringify(data));autoSnapshot(data);}
  catch(e){console.warn('localStorage: '+e.message);}
  syncToCloud();
};

async function syncToCloud(){
  if(!supabase||!supabaseConnected||!cloudUser)return;
  var data=appData;if(!data||!data.projects)return;
  try{
    for(var i=0;i<data.projects.length;i++){
      var p=data.projects[i];
      await supabase.from('projects').upsert({
        id:p.id,name:p.name,area:p.area,description:p.desc,
        updated_at:new Date().toISOString()
      },{onConflict:'id'});
    }
    if(data.baselineTypes){
      var pjIds=Object.keys(data.baselineTypes);
      for(var j=0;j<pjIds.length;j++){
        var pjId=pjIds[j],types=Object.keys(data.baselineTypes[pjId]);
        for(var k=0;k<types.length;k++){
          var tn=types[k],bt=data.baselineTypes[pjId][tn];
          await supabase.from('baseline_types').upsert({
            project_id:pjId,type_name:tn,calc_method:bt.calcMode||'offset',
            x0:bt.x0,y0:bt.y0,x1:bt.x1,y1:bt.y1,
            dx:(bt.x1||0)-(bt.x0||0),dy:(bt.y1||0)-(bt.y0||0),
            length:Math.sqrt(Math.pow((bt.x1||0)-(bt.x0||0),2)+Math.pow((bt.y1||0)-(bt.y0||0),2)),
            alert_thresholds:data.thresholds||{}
          },{onConflict:'project_id,type_name'});
        }
      }
    }
    var mKeys=Object.keys(data.measurements||{});
    for(var m=0;m<mKeys.length;m++){
      var key=mKeys[m],parts=key.split('_'),date=parts.pop(),pjKey=parts.join('_');
      await supabase.from('measurements').upsert({
        project_key:pjKey,date:date,records:data.measurements[key],
        uploaded_by:(cloudUser?cloudUser.email:'unknown')
      },{onConflict:'project_key,date'});
    }
    if(data.historyCumData){
      var hPjIds=Object.keys(data.historyCumData);
      for(var h=0;h<hPjIds.length;h++){
        var hp=hPjIds[h],points=Object.keys(data.historyCumData[hp]);
        for(var pt=0;pt<points.length;pt++){
          var point=points[pt];
          await supabase.from('history_cum_data').upsert({
            project_id:hp,point:point,entries:data.historyCumData[hp][point]
          },{onConflict:'project_id,point'});
        }
      }
    }
    var lt=document.getElementById('syncLastTime');
    if(lt)lt.textContent=new Date().toLocaleString();
  }catch(e){
    console.warn('云端同步失败: '+e.message);
    pendingSyncQueue.push({timestamp:new Date().toISOString(),error:e.message});
    try{localStorage.setItem(PENDING_SYNC_KEY,JSON.stringify(pendingSyncQueue));}catch(x){}
    updateSyncUI();
  }
}

async function syncFromCloud(){
  if(!supabase||!supabaseConnected||!cloudUser||!appData)return;
  try{
    var mr=await supabase.from('measurements').select('*');
    if(mr.data&&mr.data.length>0){
      mr.data.forEach(function(m){
        if(!appData.measurements)appData.measurements={};
        var kk=m.project_key+'_'+m.date;
        if(!appData.measurements[kk]||new Date(m.created_at||0)>new Date(appData._lastSaved||0)){
          appData.measurements[kk]=m.records;
        }
      });
    }
    var br=await supabase.from('baseline_types').select('*');
    if(br.data&&br.data.length>0){
      br.data.forEach(function(b){
        if(!appData.baselineTypes)appData.baselineTypes={};
        if(!appData.baselineTypes[b.project_id])appData.baselineTypes[b.project_id]={};
        appData.baselineTypes[b.project_id][b.type_name]={
          calcMode:b.calc_method,x0:b.x0,y0:b.y0,x1:b.x1,y1:b.y1
        };
        if(b.alert_thresholds)appData.thresholds=b.alert_thresholds;
      });
    }
    var hr=await supabase.from('history_cum_data').select('*');
    if(hr.data&&hr.data.length>0){
      hr.data.forEach(function(h){
        if(!appData.historyCumData)appData.historyCumData={};
        if(!appData.historyCumData[h.project_id])appData.historyCumData[h.project_id]={};
        appData.historyCumData[h.project_id][h.point]=h.entries;
      });
    }
    appData._lastSaved=new Date().toISOString();
    try{localStorage.setItem(APP_KEY,JSON.stringify(appData));}catch(x){}
    var lt=document.getElementById('syncLastTime');
    if(lt)lt.textContent=new Date().toLocaleString();
    addOperationLog('云同步','从Supabase拉取合并数据');
  }catch(e){console.warn('云端拉取失败: '+e.message);}
}

async function manualSync(){
  if(!supabaseConnected||!cloudUser){toast('请先配置Supabase并登录云端','error');return;}
  toast('正在同步...','info');
  await syncFromCloud();
  await syncToCloud();
  renderOverview();populateAllSelects();
  toast('同步完成','success');
}
window.manualSync=manualSync;

function saveSyncConfig(){
  var u=document.getElementById('syncUrl').value.trim();
  var k=document.getElementById('syncKey').value.trim();
  if(!u||!k){toast('请填写URL和Key','error');return;}
  localStorage.setItem(SYNC_CONFIG_KEY,JSON.stringify({url:u,key:k}));
  initSupabase();
  toast('配置已保存','success');
  setTimeout(function(){if(supabaseConnected){loadCloudUser();updateSyncUI();}},500);
}

async function testSupabaseConnection(){
  var u=document.getElementById('syncUrl').value.trim();
  var k=document.getElementById('syncKey').value.trim();
  if(!u||!k){toast('请填写URL和Key','error');return;}
  try{
    var tc=window.supabase.createClient(u,k);
    var r=await tc.from('projects').select('count',{count:'exact',head:true});
    if(r.error){toast('连接失败: '+r.error.message,'error');return;}
    toast('Supabase连接成功！','success');
    saveSyncConfig();
  }catch(e){toast('连接测试失败: '+e.message,'error');}
}
window.testSupabaseConnection=testSupabaseConnection;

async function flushPendingSync(){
  if(!supabaseConnected||!cloudUser||pendingSyncQueue.length===0)return;
  try{await syncToCloud();pendingSyncQueue=[];try{localStorage.setItem(PENDING_SYNC_KEY,'[]');}catch(x){}}catch(e){}
}

function loadSyncConfig(){
  localStorage.removeItem(SYNC_CONFIG_KEY);
  var ue=document.getElementById('syncUrl');
  var ke=document.getElementById('syncKey');
  if(ue)ue.value=SUPABASE_URL;
  if(ke)ke.value=SUPABASE_ANON_KEY;
}

// Full monitoring projects extracted from 73rd monthly report
const DEFAULT_PROJECTS=[
  {id:'p05',name:'成品料仓钢立柱',area:'矿山加工系统',desc:'C1-C21共21个测点，位移+沉降双指标',group:'矿山'},
  {id:'p06',name:'成品料网架-南侧',area:'矿山加工系统',desc:'CN3-CN53共28个测点，水平位移+沉降',group:'矿山'},
  {id:'p07',name:'成品料网架-北侧',area:'矿山加工系统',desc:'CB3-CB50共28个测点，水平位移+沉降',group:'矿山'},
  {id:'p08',name:'半成品料仓-南侧',area:'矿山加工系统',desc:'BCN1-BCN20共14个测点，水平位移+沉降',group:'矿山'},
  {id:'p09',name:'半成品料仓-北侧',area:'矿山加工系统',desc:'BCB1-BCB23共14个测点，水平位移+沉降',group:'矿山'},
  {id:'p10',name:'中细碎料仓-南侧',area:'矿山加工系统',desc:'ZXSN1-ZXSN9共6个测点',group:'矿山'},
  {id:'p11',name:'中细碎料仓-北侧',area:'矿山加工系统',desc:'ZXSB1-ZXSB9共6个测点',group:'矿山'},
  // 物流廊道
  {id:'p12',name:'物流廊道-锚杆应力计',area:'物流廊道',desc:'锚杆应力监测，应力(MPa)+状态(拉/压)',group:'物流廊道'},
  {id:'p13',name:'物流廊道-爆破振动',area:'物流廊道',desc:'爆破振动监测，X-Y-Z速度+频率',group:'物流廊道'},
  {id:'p14',name:'物流廊道-G5排架',area:'物流廊道',desc:'G5-1~G5-4及G5-1C/G5-3C/G5-4C沉降，位移+沉降',group:'物流廊道'},
  {id:'p15',name:'物流廊道-拉紧装置',area:'物流廊道',desc:'左前/左后/右前/右后4个测点，南北+东西方向位移+沉降',group:'物流廊道'},
  {id:'p16',name:'物流廊道-钢立柱',area:'物流廊道',desc:'钢立柱位移+沉降监测',group:'物流廊道'},
  {id:'p17',name:'物流廊道-廊道排架G3-G7',area:'物流廊道',desc:'G3/G4/G6/G7及D/F后缀共47个点位，位移+沉降',group:'物流廊道'},
  {id:'p18',name:'物流廊道-金磊长胶搭接处',area:'物流廊道',desc:'zs/zx/ys/yx/yb/zb系列20个点位，含立柱+边坡测点',group:'物流廊道'},
  {id:'p19',name:'物流廊道-马料湖段钢立柱',area:'物流廊道',desc:'W1-W15共15个测点，位移+沉降',group:'物流廊道'},
  // 陆域堆场-成品料堆场
  {id:'p21',name:'成品料网架基础A轴',area:'陆域堆场-成品料',desc:'A02-A86共31个点位，多阶段累计位移(限高15m/16m/17.5m/18m)',group:'陆域堆场'},
  {id:'p22',name:'成品料网架基础B轴',area:'陆域堆场-成品料',desc:'B2-B83共29个点位，多阶段累计位移',group:'陆域堆场'},
  {id:'p23',name:'成品料地基土体水平位移',area:'陆域堆场-成品料',desc:'IN1-C1~IN11-C4共11个测斜孔，累计最大位移+深度+速率',group:'陆域堆场'},
  {id:'p24',name:'成品料仓地弄沉降',area:'陆域堆场-成品料',desc:'D1-1~D4-16共64个点，按大石仓/小石仓/砂仓/中石仓分区',group:'陆域堆场'},
  // 陆域堆场-混合料试验区
  {id:'p26',name:'试验区网架基础A轴',area:'陆域堆场-试验区',desc:'A50-A59共10个点位，7阶段累计位移(高压旋喷~限高19m)',group:'陆域堆场'},
  {id:'p27',name:'试验区网架基础B轴',area:'陆域堆场-试验区',desc:'B50-B59共10个点位',group:'陆域堆场'},
  {id:'p28',name:'试验区地表沉降(T1-T13)',area:'陆域堆场-试验区',desc:'13个沉降标(部分掩埋)，两次堆载试验沉降量+累计+速率',group:'陆域堆场'},
  {id:'p29',name:'试验区地基水平位移(测斜)',area:'陆域堆场-试验区',desc:'I1/I2/I9/I10/I11/I15/I16/I18共8个孔',group:'陆域堆场'},
  // 陆域堆场-推广区
  {id:'p31',name:'推广区网架基础A轴',area:'陆域堆场-推广区',desc:'A3-A49共30个点位，3阶段累计位移(限高15m/16.5m/17m)',group:'陆域堆场'},
  {id:'p32',name:'推广区网架基础B轴',area:'陆域堆场-推广区',desc:'B3-B48共15个点位',group:'陆域堆场'},
  // 码头平台
  {id:'p33',name:'码头平台沉降',area:'码头',desc:'77个水准点，码头与长江大堤沉降观测',group:'码头'}
];

const DEFAULT_APP_DATA={
  projects:DEFAULT_PROJECTS,
  measurements:{},
  inclinometerData:{},
  incData:{},        // 测斜监测（深度×时间矩阵）
  convData:{},       // 收敛监测（两点距离对比）
  historyCumData:{},
  stages:{},
  baselines:{},
  thresholds:{},
  baselineTypes:{}, // per-type baseline config: {pjId: {typeName: {calcMode, x0,y0,x1,y1}}}
  anchorStress:{},
  blastVibration:{},
  convergence:{},
  waterLevel:{},
  staticLevel:{},
  tunnelSettlement:{}
};

const DEFAULT_THRESHOLDS={
  disp_yellow:5,disp_orange:10,disp_red:20,
  cum_yellow:30,cum_orange:50,cum_red:80,
  settle_yellow:10,settle_orange:30,settle_red:50
};

const COLORS28=[
  '#1F4E79','#8B2252','#6B8E23','#3A7D8C','#4A3872','#B87A3F','#4A7EB0','#993333',
  '#A8C673','#7A6BC0','#408080','#E8A735','#4DA8B5','#5A92C1','#D4A0A0','#AEBC34',
  '#5AB8E0','#E89A2A','#B0C4DE','#D6A0A0','#B8D0A8','#C0B8D0','#A8D8E8'
];

const AREA_COLORS={矿山:'#1a73e8','物流廊道':'#e37400','陆域堆场':'#7b1fa2',码头:'#137333'};

let appData=null;
let currentUser=null;

function viewProjectData(pid){
  switchPanel('process');
  setTimeout(function(){
    $('processProject').value=pid;
    populateProcessDates();
  },50);
}

function $(id){return document.getElementById(id);}
function scrollToElement(el){if(el)el.scrollIntoView({behavior:'smooth',block:'center'});}
function formatDate(d){return d.toISOString().split('T')[0];}
function toast(msg,type='info'){
  const t=document.createElement('div');t.className='toast '+type;t.textContent=msg;
  document.body.appendChild(t);setTimeout(()=>t.remove(),3000);
}
function uuid(){return 'xxxx-xxxx'.replace(/x/g,()=>(Math.random()*16|0).toString(16));}
function simpleHash(s){let h=0;for(let i=0;i<s.length;i++){h=((h<<5)-h)+s.charCodeAt(i);h|=0;}return h.toString(36);}

// ==================== CALCULATION ENGINE ====================
function getBaselineForType(pjId, typeName){
  if(appData.baselineTypes && appData.baselineTypes[pjId] && appData.baselineTypes[pjId][typeName]){
    return appData.baselineTypes[pjId][typeName];
  }
  // Fallback to project-level baseline
  const bl=appData.baselines[pjId];
  if(bl)return {calcMode:'offset',x0:bl.x0,y0:bl.y0,x1:bl.x1,y1:bl.y1};
  return {calcMode:'offset',x0:1000,y0:1000,x1:1100,y1:1000};
}

function calcOffsetDistance(ix,iy,cx,cy,bl){
  // Offset: perpendicular distance from point to baseline
  // d = ((yi-y0)*(x1-x0) - (xi-x0)*(y1-y0)) / length
  const dx=bl.x1-bl.x0,dy=bl.y1-bl.y0,length=Math.sqrt(dx*dx+dy*dy);
  if(length<1e-10)return {dInit:0,dCurr:0,dDisp:0};
  const dInit=((iy-bl.y0)*dx-(ix-bl.x0)*dy)/length;
  const dCurr=((cy-bl.y0)*dx-(cx-bl.x0)*dy)/length;
  const dDisp=(dCurr-dInit)*1000; // mm
  return {dInit:parseFloat(dInit.toFixed(10)),dCurr:parseFloat(dCurr.toFixed(10)),dDisp:parseFloat(dDisp.toFixed(2))};
}

function calcChainageDistance(ix,iy,cx,cy,bl){
  // Chainage: projection distance along baseline direction
  // chain = ((xi-x0)*(x1-x0) + (yi-y0)*(y1-y0)) / length
  const dx=bl.x1-bl.x0,dy=bl.y1-bl.y0,length=Math.sqrt(dx*dx+dy*dy);
  if(length<1e-10)return {dInit:0,dCurr:0,dDisp:0};
  const chainInit=((ix-bl.x0)*dx+(iy-bl.y0)*dy)/length;
  const chainCurr=((cx-bl.x0)*dx+(cy-bl.y0)*dy)/length;
  const chainDisp=(chainCurr-chainInit)*1000; // mm
  return {dInit:parseFloat(chainInit.toFixed(10)),dCurr:parseFloat(chainCurr.toFixed(10)),dDisp:parseFloat(chainDisp.toFixed(2))};
}

function calcDisplacement(ix,iy,iz,cx,cy,cz,bl,calcMode){
  let dispResult;
  if(calcMode==='chainage'){
    dispResult=calcChainageDistance(ix,iy,cx,cy,bl);
  }else{
    dispResult=calcOffsetDistance(ix,iy,cx,cy,bl);
  }
  const settle=parseFloat(((cz-iz)*1000).toFixed(2));
  return {
    ...dispResult,
    settle,
    calcMode:calcMode
  };
}

// ==================== ACCOUNT SYSTEM ====================
function loadUser(){
  try{const raw=localStorage.getItem(USER_KEY);if(raw){currentUser=JSON.parse(raw);}}catch(e){currentUser=null;}
}

function doLogin(){
  const u=$('loginUser').value.trim(),p=$('loginPass').value.trim();
  if(!u||!p){$('loginMsg').textContent='请输入用户名和密码';return;}
  const stored=localStorage.getItem('user_'+simpleHash(u));
  if(stored){
    const data=JSON.parse(stored);
    if(data.passHash===simpleHash(p)){
      currentUser={name:u,passHash:simpleHash(p),created:data.created};
      localStorage.setItem(USER_KEY,JSON.stringify(currentUser));
      $('loginOverlay').style.display='none';initApp();
    }else{$('loginMsg').textContent='密码错误';}
  }else{
    const userData={name:u,passHash:simpleHash(p),created:new Date().toISOString()};
    localStorage.setItem('user_'+simpleHash(u),JSON.stringify(userData));
    currentUser={name:u,passHash:simpleHash(p),created:userData.created};
    localStorage.setItem(USER_KEY,JSON.stringify(currentUser));
    $('loginOverlay').style.display='none';initApp();
  }
}

function skipLogin(){
  currentUser={name:'离线用户',passHash:'',created:new Date().toISOString()};
  localStorage.setItem(USER_KEY,JSON.stringify(currentUser));
  $('loginOverlay').style.display='none';initApp();
}

function changePassword(){
  const np=$('accountNewPass').value.trim(),cp=$('accountConfirmPass').value.trim();
  if(!np||np!==cp){$('accountMsg').textContent='两次密码不一致或为空';$('accountMsg').style.color='#c5221f';return;}
  if(!currentUser||currentUser.name==='离线用户'){$('accountMsg').textContent='离线用户无法修改密码';$('accountMsg').style.color='#c5221f';return;}
  const key='user_'+simpleHash(currentUser.name),stored=localStorage.getItem(key);
  if(stored){const data=JSON.parse(stored);data.passHash=simpleHash(np);localStorage.setItem(key,JSON.stringify(data));}
  currentUser.passHash=simpleHash(np);localStorage.setItem(USER_KEY,JSON.stringify(currentUser));
  $('accountMsg').textContent='密码修改成功';$('accountMsg').style.color='#137333';
  $('accountNewPass').value='';$('accountConfirmPass').value='';
}

function logoutUser(){
  currentUser=null;localStorage.removeItem(USER_KEY);
  $('loginOverlay').style.display='flex';$('loginMsg').textContent='';
  $('loginUser').value='';$('loginPass').value='';
}

// ==================== APP INIT ====================
function initApp(){
  initSupabase();
  // Bind sidebar click events (deferred to ensure DOM ready, fixes panel switching)
  document.querySelectorAll('.sidebar-item').forEach(item=>{item.addEventListener('click',function(){const p=this.dataset.panel;if(p)switchPanel(p);});});
  try{var pq=JSON.parse(localStorage.getItem(PENDING_SYNC_KEY)||'[]');pendingSyncQueue=pq;}catch(e){pendingSyncQueue=[];}

  try{
    const raw=localStorage.getItem(APP_KEY);
    if(raw){
      appData=JSON.parse(raw);
      const defaults=['anchorStress','blastVibration','convergence','waterLevel','staticLevel','tunnelSettlement','baselineTypes'];
      defaults.forEach(k=>{if(!(k in appData))appData[k]={};});
      if(!appData.thresholds)appData.thresholds=DEFAULT_THRESHOLDS;
      // Ensure projects match current full list
      if(!appData.projects||appData.projects.length<30){
        const existingIds=new Set((appData.projects||[]).map(p=>p.id));
        DEFAULT_PROJECTS.forEach(dp=>{if(!existingIds.has(dp.id))appData.projects.push(dp);});
      }
    }else{
      appData=JSON.parse(JSON.stringify(DEFAULT_APP_DATA));
      appData.baselines={};
      appData.baselineTypes={};
      appData.thresholds=JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS));
      appData.anchorStress={};appData.blastVibration={};appData.convergence={};
      appData.waterLevel={};appData.staticLevel={};appData.tunnelSettlement={};
      saveData(appData);
    }
  }catch(e){
    console.error(e);
    appData=JSON.parse(JSON.stringify(DEFAULT_APP_DATA));
    appData.baselines={};appData.baselineTypes={};
    appData.thresholds=JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS));
    appData.anchorStress={};appData.blastVibration={};appData.convergence={};
    appData.waterLevel={};appData.staticLevel={};appData.tunnelSettlement={};
  }
  if(currentUser){
    $('sidebarUser').textContent=currentUser.name;$('accountUser').value=currentUser.name;
    $('userDot').classList.remove('offline');
  }else{$('sidebarUser').textContent='离线用户';$('userDot').classList.add('offline');}
  renderOverview();populateAllSelects();renderVersions();refreshFileInfo();updateClock();
  setInterval(updateClock,30000);
}

function saveData(data){
  data._lastSaved=new Date().toISOString();data._savedBy=currentUser?currentUser.name:'unknown';data._version=5.1;
  localStorage.setItem(APP_KEY,JSON.stringify(data));autoSnapshot(data);
}

function autoSnapshot(data){
  const versions=JSON.parse(localStorage.getItem(VERSIONS_KEY)||'[]');
  if(versions.length>0){const last=versions[versions.length-1];if(Date.now()-new Date(last.time).getTime()<60000)return;}
  versions.push({time:new Date().toISOString(),user:currentUser?currentUser.name:'unknown',desc:'自动快照 ('+Object.keys(data.measurements||{}).length+'期数据)',data:JSON.parse(JSON.stringify(data))});
  if(versions.length>50)versions.shift();
  localStorage.setItem(VERSIONS_KEY,JSON.stringify(versions));
}

function createSnapshot(){
  const versions=JSON.parse(localStorage.getItem(VERSIONS_KEY)||'[]');
  versions.push({time:new Date().toISOString(),user:currentUser?currentUser.name:'unknown',desc:'手动快照 ('+Object.keys(appData.measurements||{}).length+'期数据)',data:JSON.parse(JSON.stringify(appData))});
  if(versions.length>50)versions.shift();localStorage.setItem(VERSIONS_KEY,JSON.stringify(versions));
  renderVersions();toast('快照已创建','success');addOperationLog('版本管理','创建手动快照');
}

function clearVersions(){
  if(!confirm('确定清空所有版本快照？此操作不可恢复。'))return;
  localStorage.setItem(VERSIONS_KEY,'[]');renderVersions();toast('所有快照已清空','info');
}

function renderVersions(){
  const versions=JSON.parse(localStorage.getItem(VERSIONS_KEY)||'[]'),container=$('versionList');
  if(versions.length===0){container.innerHTML='<div class="empty-state"><div class="icon">&#8635;</div>暂无版本快照</div>';return;}
  let html='';
  versions.reverse().forEach((v,i)=>{
    const idx=versions.length-1-i,dt=new Date(v.time);
    const timeStr=dt.getFullYear()+'-'+(dt.getMonth()+1).toString().padStart(2,'0')+'-'+dt.getDate().toString().padStart(2,'0')+' '+dt.getHours().toString().padStart(2,'0')+':'+dt.getMinutes().toString().padStart(2,'0');
    html+='<div class="version-item"><div class="v-info"><div class="v-desc"><strong>#'+(idx+1)+'</strong> '+v.desc+'</div><div class="v-time">'+timeStr+' | '+v.user+'</div></div><div style="display:flex;gap:4px"><button class="btn btn-sm btn-outline" onclick="viewVersion('+idx+')">查看</button><button class="btn btn-sm btn-primary" onclick="restoreVersion('+idx+')">还原</button></div></div>';
  });
  container.innerHTML=html;
}

function viewVersion(idx){
  const versions=JSON.parse(localStorage.getItem(VERSIONS_KEY)||'[]'),v=versions[idx];
  if(!v)return;
  const modal=$('versionDetailContent'),summary={时间:v.time,用户:v.user,描述:v.desc,子项目数:(v.data.projects||[]).length,测量期数:Object.keys(v.data.measurements||{}).length,锚杆应力记录:Object.keys(v.data.anchorStress||{}).length,爆破振动记录:Object.keys(v.data.blastVibration||{}).length};
  modal.innerHTML='<h3>版本快照详情</h3><table>'+Object.entries(summary).map(([k,vv])=>'<tr><td><strong>'+k+'</strong></td><td>'+vv+'</td></tr>').join('')+'</table>';
  $('versionDetailModal').classList.add('show');
}

function restoreVersion(idx){
  if(!confirm('确定还原到此版本？当前数据将被覆盖。建议先创建快照。'))return;
  const versions=JSON.parse(localStorage.getItem(VERSIONS_KEY)||'[]'),v=versions[idx];
  if(!v)return;appData=JSON.parse(JSON.stringify(v.data));saveData(appData);
  renderOverview();populateAllSelects();toast('已还原到版本 #'+(idx+1),'success');addOperationLog('版本管理','还原到版本 #'+(idx+1));
}

// ==================== SHARE CODE ====================
function generateShareCode(){
  const selected=[];document.querySelectorAll('#shareProjects input:checked').forEach(cb=>selected.push(cb.value));
  if(selected.length===0){toast('请选择至少一个子项目','error');return;}
  const shareData={v:'5.1',time:new Date().toISOString(),user:currentUser?currentUser.name:'unknown',projects:selected,data:{}};
  selected.forEach(pjId=>{
    shareData.data[pjId]={};
    if(appData.baselineTypes&&appData.baselineTypes[pjId])shareData.data[pjId].baselineTypes=appData.baselineTypes[pjId];
    shareData.data[pjId].thresholds=appData.thresholds;
    Object.keys(appData.measurements||{}).filter(k=>k.startsWith(pjId+'_')).forEach(k=>{shareData.data[pjId][k]=appData.measurements[k];});
    Object.keys(appData.inclinometerData||{}).filter(k=>k.startsWith(pjId+'_')).forEach(k=>{shareData.data[pjId][k]=appData.inclinometerData[k];});
    if(appData.historyCumData[pjId])shareData.data[pjId].historyCum=appData.historyCumData[pjId];
    Object.keys(appData.anchorStress||{}).filter(k=>k.startsWith(pjId+'_')).forEach(k=>{shareData.data[pjId][k]=appData.anchorStress[k];});
    Object.keys(appData.blastVibration||{}).filter(k=>k.startsWith(pjId+'_')).forEach(k=>{shareData.data[pjId][k]=appData.blastVibration[k];});
    Object.keys(appData.convergence||{}).filter(k=>k.startsWith(pjId+'_')).forEach(k=>{shareData.data[pjId][k]=appData.convergence[k];});

  });
  const code=btoa(unescape(encodeURIComponent(JSON.stringify(shareData))));
  $('shareCodeBox').style.display='block';$('shareCodeBox').textContent=code;
  toast('分享码已生成','success');addOperationLog('分享','生成分享码 ('+selected.join(',')+')');
}

function importShareCode(){
  const code=$('importShareCode').value.trim();
  if(!code){toast('请粘贴分享码','error');return;}
  try{
    const json=decodeURIComponent(escape(atob(code))),shareData=JSON.parse(json);
    if(shareData.v!=='5.1'&&shareData.v!=='5.0'){toast('分享码版本不兼容','error');return;}
    const projects=shareData.projects||[];let imported=0;
    projects.forEach(pjId=>{
      const d=shareData.data[pjId];if(!d)return;
      if(d.baselineTypes && !appData.baselineTypes)appData.baselineTypes={};
      if(d.baselineTypes)appData.baselineTypes[pjId]=d.baselineTypes;
      if(d.thresholds)appData.thresholds=d.thresholds;
      Object.keys(d).forEach(k=>{
        if(k==='baseline'||k==='baselineTypes'||k==='thresholds'||k==='historyCum')return;
        if(k.startsWith(pjId+'_')){
          if(!appData.measurements)appData.measurements={};
          appData.measurements[k]=d[k];imported++;
        }
      });
      if(d.historyCum){if(!appData.historyCumData)appData.historyCumData={};if(!appData.historyCumData[pjId])appData.historyCumData[pjId]={};Object.assign(appData.historyCumData[pjId],d.historyCum);}
    });
    saveData(appData);
    $('importShareResult').textContent='成功导入 '+imported+' 期数据';$('importShareResult').style.color='#137333';
    renderOverview();populateAllSelects();toast('分享码导入成功！共 '+imported+' 期','success');addOperationLog('分享','导入分享码 ('+imported+'期)');
  }catch(e){$('importShareResult').textContent='分享码解析失败: '+e.message;$('importShareResult').style.color='#c5221f';toast('分享码解析失败','error');}
}

// ==================== SIDEBAR NAV ====================
function switchPanel(panelName){
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  const panel=$('panel-'+panelName);if(panel)panel.classList.add('active');
  document.querySelectorAll('.sidebar-item').forEach(item=>item.classList.remove('active'));
  const item=document.querySelector('[data-panel="'+panelName+'"]');if(item)item.classList.add('active');
  const breadcrumbs={dashboard:'项目总览',baseline:'基线配置',import:'数据导入',process:'数据处理',history:'历史管理',report:'报告生成',share:'分享与导入',versions:'版本历史',account:'账户管理',sync:'云同步设置'};
  const bc=$('breadcrumb');if(bc)bc.textContent=breadcrumbs[panelName]||panelName;
  if(panelName==='dashboard')renderOverview();
  if(panelName==='baseline'){populateBaselineSelect();loadBaselineType();}
  if(panelName==='import'){populateImportSelect();showImportHint();onFormatChange();}
  if(panelName==='process'){populateProcessSelect();}
  if(panelName==='history'){populateHistorySelect();renderHistPanel();}
  if(panelName==='report'){populateReportSelect();}
  if(panelName==='share')populateShareSelect();
  if(panelName==='versions')renderVersions();
  if(panelName==='account'){$('accountUser').value=currentUser?currentUser.name:'';}
  if(panelName==='sync'){loadSyncConfig();updateSyncUI();}
}
document.querySelectorAll('.sidebar-item').forEach(item=>{item.addEventListener('click',function(){const p=this.dataset.panel;if(p)switchPanel(p);});});

// ==================== DASHBOARD ====================
function renderOverview(){
  const mCount=Object.keys(appData.measurements||{}).length;
  const aCount=Object.keys(appData.anchorStress||{}).length;
  const bCount=Object.keys(appData.blastVibration||{}).length;
  const cCount=Object.keys(appData.convergence||{}).length;
  const wCount=Object.keys(appData.waterLevel||{}).length;
  const totalProj=(appData.projects||[]).length;
  const groups=new Set((appData.projects||[]).map(p=>p.group));
  const totalOther=aCount+bCount+cCount+wCount;

  $('statGrid').innerHTML=
    '<div class="stat-card blue"><div class="value">'+totalProj+'</div><div class="label">监测子项目</div></div>'+
    '<div class="stat-card green"><div class="value">'+groups.size+'</div><div class="label">监测部位分组</div></div>'+
    '<div class="stat-card orange"><div class="value">'+(mCount+totalOther)+'</div><div class="label">总监测期/记录数</div></div>'+
    '<div class="stat-card purple"><div class="value">8</div><div class="label">监测类型覆盖</div></div>';

  // Group projects by area
  const grouped={};
  (appData.projects||[]).forEach(p=>{
    if(!grouped[p.group])grouped[p.group]=[];
    grouped[p.group].push(p);
  });

  let projHTML='';
  Object.keys(grouped).forEach(group=>{
    projHTML+='<div class="area-header">'+group+' <span class="badge" style="margin-left:8px;background:'+(AREA_COLORS[group]||'#999')+';color:#fff">'+grouped[group].length+'个子项</span></div>';
    projHTML+='<div class="project-grid">';
    grouped[group].forEach(p=>{
      const mKeys=Object.keys(appData.measurements||{}).filter(k=>k.startsWith(p.id+'_'));
      const aKeys=Object.keys(appData.anchorStress||{}).filter(k=>k.startsWith(p.id+'_'));
      const bKeys=Object.keys(appData.blastVibration||{}).filter(k=>k.startsWith(p.id+'_'));
      const iKeys=Object.keys(appData.inclinometerData||{}).filter(k=>k.startsWith(p.id+'_'));
      const incKeys=appData.incData&&appData.incData[p.id]?[p.id]:[];
      const convKeys=appData.convData&&appData.convData[p.id]?[p.id]:[];
      let tagHTML='<span class="tag">'+p.area+'</span>';
      if(mKeys.length>0)tagHTML+='<span class="tag success">位移'+mKeys.length+'期</span>';
      if(aKeys.length>0)tagHTML+='<span class="tag purple">锚杆应力'+aKeys.length+'期</span>';
      if(bKeys.length>0)tagHTML+='<span class="tag warn">爆破'+bKeys.length+'期</span>';
      if(iKeys.length>0)tagHTML+='<span class="tag cyan">测斜'+iKeys.length+'期</span>';
      if(incKeys.length>0)tagHTML+='<span class="tag" style="background:#8B2252;color:#fff">测斜矩阵</span>';
      if(convKeys.length>0)tagHTML+='<span class="tag" style="background:#6B8E23;color:#fff">收敛</span>';
      if(mKeys.length===0&&aKeys.length===0&&bKeys.length===0&&iKeys.length===0&&incKeys.length===0&&convKeys.length===0)tagHTML+='<span class="tag neutral">暂无数据</span>';
      projHTML+='<div class="project-card"><div class="card-actions"><button class="btn-icon primary" onclick="event.stopPropagation();showProjectModal(\''+p.id+'\')" title="编辑">&#9998;</button><button class="btn-icon danger" onclick="event.stopPropagation();deleteProject(\''+p.id+'\')" title="删除">&#10005;</button></div><h4>'+p.name+'</h4><div class="tags">'+tagHTML+'</div><div class="meta">'+p.desc+'</div><div style="margin-top:8px"><button class="btn btn-sm btn-outline" onclick="viewProjectData(\''+p.id+'\');">查看数据</button><button class="btn btn-sm btn-outline" style="margin-left:4px" onclick="switchPanel(\'import\');$(\'importProject\').value=\''+p.id+'\';onFormatChange();">导入数据</button></div></div>';
    });
    projHTML+='</div>';
    projHTML+='<button class="btn-add-project" onclick="showProjectModal()">+ 新增子项目</button>';
  });
  $('projectList').innerHTML=projHTML||'<div class="empty-state">暂无项目</div>';

  const logs=JSON.parse(localStorage.getItem(LOG_KEY)||'[]');
  $('recentLogs').innerHTML=logs.slice(-10).reverse().map(l=>'<div style="padding:4px 0;border-bottom:1px solid #f0f0f0">['+l.time+'] <strong>'+l.action+'</strong>: '+l.detail+'</div>').join('')||'<div class="empty-state">暂无操作日志</div>';
}

// ==================== PROJECT CRUD ====================
function showProjectModal(pjId){
  if(pjId){
    const p=(appData.projects||[]).find(x=>x.id===pjId);
    if(p){
      $('projectEditId').value=p.id;
      $('projectEditName').value=p.name;
      $('projectEditDesc').value=p.desc||'';
      $('projectEditArea').value=p.area||'';
      $('projectEditGroup').value=p.group||'';
      $('projectModalTitle').textContent='编辑子项目';
      // Pre-check types based on existing data (simplified: check all stores)
      const cbs=document.querySelectorAll('#projectEditTypes input[type="checkbox"]');
      cbs.forEach(cb=>{cb.checked=false;});
      // Mark types that have data for this project
      const typeMap={measurements:'measurements',anchorStress:'anchorStress',blastVibration:'blastVibration',convergence:'convergence',waterLevel:'waterLevel',inclinometerData:'inclinometerData',incData:'incData',convData:'convData'};
      Object.keys(typeMap).forEach(cbVal=>{
        const storeName=typeMap[cbVal];
        if(storeName==='incData'||storeName==='convData'){if(appData[storeName]&&appData[storeName][pjId]){const cb=document.querySelector('#projectEditTypes input[value="'+cbVal+'"]');if(cb)cb.checked=true;}}
        else{const exists=Object.keys(appData[storeName]||{}).some(k=>k.startsWith(pjId+'_'));if(exists){const cb=document.querySelector('#projectEditTypes input[value="'+cbVal+'"]');if(cb)cb.checked=true;}}
      });
    }
  }else{
    $('projectEditId').value='';
    $('projectEditName').value='';
    $('projectEditDesc').value='';
    $('projectEditArea').value='矿山加工系统';
    $('projectEditGroup').value='矿山';
    $('projectModalTitle').textContent='新增子项目';
    const cbs=document.querySelectorAll('#projectEditTypes input[type="checkbox"]');
    cbs.forEach(cb=>{cb.checked=false;});
  }
  $('projectModal').classList.add('show');
}

function saveProject(){
  const pjId=$('projectEditId').value;
  const name=$('projectEditName').value.trim();
  const desc=$('projectEditDesc').value.trim();
  const area=$('projectEditArea').value;
  const group=$('projectEditGroup').value;
  if(!name){toast('请输入项目名称','error');return;}
  if(!area){toast('请选择所属区域','error');return;}

  if(pjId){
    // Edit existing
    const p=appData.projects.find(x=>x.id===pjId);
    if(p){p.name=name;p.desc=desc;p.area=area;p.group=group;}
    toast('项目已更新','success');
    addOperationLog('编辑项目','修改 '+name+' ('+pjId+')');
  }else{
    // Generate new ID
    const existingIds=new Set((appData.projects||[]).map(p=>p.id));
    let newId='p34';let n=34;
    while(existingIds.has(newId)){n++;newId='p'+n;}
    appData.projects.push({id:newId,name,desc,area,group});
    toast('新项目已创建','success');
    addOperationLog('新增项目','创建 '+name+' ('+newId+')');
  }
  saveData(appData);
  $('projectModal').classList.remove('show');
  renderOverview();populateAllSelects();
}

function cleanupProjectData(pjId){
  // Remove all data associated with this project from all stores
  const storesWithPrefix=['measurements','inclinometerData','anchorStress','blastVibration','convergence','waterLevel','staticLevel','tunnelSettlement','historyCumData','stages'];
  storesWithPrefix.forEach(s=>{
    const obj=appData[s]||{};
    Object.keys(obj).forEach(k=>{if(k.startsWith(pjId+'_'))delete obj[k];});
  });
  // Stores with direct project ID key
  ['incData','convData'].forEach(s=>{
    if(appData[s]&&appData[s][pjId])delete appData[s][pjId];
  });
  // Baselines
  if(appData.baselines&&appData.baselines[pjId])delete appData.baselines[pjId];
  if(appData.baselineTypes&&appData.baselineTypes[pjId])delete appData.baselineTypes[pjId];
}

function deleteProject(pjId){
  const p=(appData.projects||[]).find(x=>x.id===pjId);
  if(!p){toast('项目不存在','error');return;}
  // Count associated data
  let dataCount=0;
  ['measurements','inclinometerData','anchorStress','blastVibration','convergence','waterLevel','staticLevel','tunnelSettlement'].forEach(s=>{
    dataCount+=Object.keys(appData[s]||{}).filter(k=>k.startsWith(pjId+'_')).length;
  });
  if(appData.incData&&appData.incData[pjId])dataCount++;
  if(appData.convData&&appData.convData[pjId])dataCount++;
  if(appData.baselines&&appData.baselines[pjId])dataCount++;
  if(appData.baselineTypes&&appData.baselineTypes[pjId])dataCount++;

  const confirmMsg=dataCount>0?'将删除项目"'+p.name+'"及其关联的 '+dataCount+' 条监测数据，此操作不可撤销。确认删除？':'确认删除项目"'+p.name+'"？';
  if(!confirm(confirmMsg))return;

  // Remove from projects list
  appData.projects=appData.projects.filter(x=>x.id!==pjId);
  // Cleanup all associated data
  cleanupProjectData(pjId);
  saveData(appData);
  toast('项目"'+p.name+'"已删除','success');
  addOperationLog('删除项目','删除 '+p.name+' ('+pjId+')，清理关联数据');
  renderOverview();populateAllSelects();
}

function addOperationLog(action,detail){
  const logs=JSON.parse(localStorage.getItem(LOG_KEY)||'[]');
  logs.push({time:new Date().toLocaleString(),action,detail,user:currentUser?currentUser.name:'unknown'});
  if(logs.length>200)logs.shift();localStorage.setItem(LOG_KEY,JSON.stringify(logs));
}
function refreshFileInfo(){}
function updateClock(){
  const now=new Date();
  $('clockDisplay').textContent=now.getFullYear()+'-'+(now.getMonth()+1).toString().padStart(2,'0')+'-'+now.getDate().toString().padStart(2,'0')+' '+now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0');
}

// ==================== BASELINE (per-type) ====================
function populateBaselineSelect(){
  const sel=$('baselineProject');
  sel.innerHTML=(appData.projects||[]).map(p=>'<option value="'+p.id+'">['+p.group+'] '+p.name+'</option>').join('');
}

function onCalcModeChange(){
  const mode=$('blCalcMode').value;
  $('baselineCoords').style.display=(mode==='offset'||mode==='chainage')?'block':'none';
}

function loadBaselineType(){
  const pjId=$('baselineProject').value;
  const typeName=$('baselineType').value;
  const bt=(appData.baselineTypes&&appData.baselineTypes[pjId]&&appData.baselineTypes[pjId][typeName])||getBaselineForType(pjId,typeName);
  const th=appData.thresholds||DEFAULT_THRESHOLDS;

  $('blCalcMode').value=bt.calcMode||'offset';
  $('blX0').value=bt.x0||1000;$('blY0').value=bt.y0||1000;
  $('blX1').value=bt.x1||1100;$('blY1').value=bt.y1||1000;
  const dx=(bt.x1||1100)-(bt.x0||1000),dy=(bt.y1||1000)-(bt.y0||1000);
  $('blAzimuth').value=((Math.atan2(dx,dy)*180/Math.PI+360)%360).toFixed(4);
  $('blLength').value=Math.sqrt(dx*dx+dy*dy).toFixed(4);
  $('thDispY').value=th.disp_yellow;$('thDispO').value=th.disp_orange;$('thDispR').value=th.disp_red;
  $('thCumY').value=th.cum_yellow;$('thCumO').value=th.cum_orange;$('thCumR').value=th.cum_red;
  $('thSettleY').value=th.settle_yellow;$('thSettleO').value=th.settle_orange;$('thSettleR').value=th.settle_red;
  onCalcModeChange();
}

function loadBaseline(){loadBaselineType();}

function saveBaseline(){
  const pjId=$('baselineProject').value;
  const typeName=$('baselineType').value;
  const calcMode=$('blCalcMode').value;
  const x0=parseFloat($('blX0').value),y0=parseFloat($('blY0').value),x1=parseFloat($('blX1').value),y1=parseFloat($('blY1').value);

  if(!appData.baselineTypes)appData.baselineTypes={};
  if(!appData.baselineTypes[pjId])appData.baselineTypes[pjId]={};
  appData.baselineTypes[pjId][typeName]={calcMode,x0,y0,x1,y1};

  appData.thresholds={
    disp_yellow:parseFloat($('thDispY').value),disp_orange:parseFloat($('thDispO').value),disp_red:parseFloat($('thDispR').value),
    cum_yellow:parseFloat($('thCumY').value),cum_orange:parseFloat($('thCumO').value),cum_red:parseFloat($('thCumR').value),
    settle_yellow:parseFloat($('thSettleY').value),settle_orange:parseFloat($('thSettleO').value),settle_red:parseFloat($('thSettleR').value)
  };
  saveData(appData);
  toast('基线配置已保存（'+pjId+' - '+typeName+'，'+calcMode+'模式）','success');
  addOperationLog('基线配置','更新 '+pjId+' '+typeName+' 基线('+calcMode+')');
}

// ==================== IMPORT ====================
function populateImportSelect(){
  const sel=$('importProject');
  sel.innerHTML=(appData.projects||[]).map(p=>'<option value="'+p.id+'">['+p.group+'] '+p.name+'</option>').join('');
  $('importDate').value=formatDate(new Date());
}

function onFormatChange(){
  const fmt=$('importFormat').value;
  $('importCalcModeRow').style.display=(fmt==='A')?'flex':'none';
  $('manualBaselineRow').style.display='none';
  showImportHint();
}

function onBaselineSourceChange(){
  $('manualBaselineRow').style.display=$('importBaselineSource').value==='manual'?'block':'none';
}

function showImportHint(){
  const fmt=$('importFormat').value;
  const hints={
    'A':'<strong>格式A（可选用偏距法或桩号法）：</strong>每行7列：点名 X初始 Y初始 Z初始 X当前 Y当前 Z当前<br>偏距法：d=((yi-y0)*(x1-x0)-(xi-x0)*(y1-y0))/L → 垂直偏移距离<br>桩号法：chain=((xi-x0)*(x1-x0)+(yi-y0)*(y1-y0))/L → 沿基线投影距离<br>沉降=Z当前-Z初始',
    'B':'<strong>格式B：</strong>每行3列：点名 H初始 H当前<br>沉降量 = H当前 - H初始',
    'C':'<strong>格式C：</strong>每行3列：孔号 深度(m) 累计位移(mm)<br>支持同一孔号多行（不同深度）',
    'D':'<strong>格式D：</strong>每行3列：点名 应力值(MPa) 状态<br>状态可选：拉/压，留空自动判断（正值拉、负值压）',
    'E':'<strong>格式E：</strong>每行2列：点名 水位高程(m)',
    'F':'<strong>格式F：</strong>每行7列：点名 X速度(cm/s) Y速度 Z速度 X频率(Hz) Y频率 Z频率',
    'G':'<strong>格式G：</strong>每行2列：点名 测线长度(mm)',
    'H':'<strong>格式H - 测斜矩阵：</strong>Excel格式，第1列深度(m)，后续列为各日期累计变化量(mm)<br>表头示例：深度（m）| 2026-05-19 | 2026-05-26 | ...<br>自动解析为深度×时间矩阵，不参考基线，各期独立对比',
    'I':'<strong>格式I - 收敛测线：</strong>每行2列：测点对（如A-B） 实测距离(mm)<br>首次测量值为基准，后续各期与基准对比计算累计变化量'
  };
  const placeholders={
    'A':'点名 A B C D E F → 点名 X初始 Y初始 Z初始 X当前 Y当前 Z当前',
    'B':'点名 H初始 H当前 → 点名 H初始(mm) H当前(mm)',
    'C':'孔号 深度(m) 累计位移(mm) → 支持同一孔号多行不同深度',
    'D':'点名 应力值(MPa) 状态 → 状态留空自动判断(tensile/compressive)',
    'E':'点名 水位高程(m)',
    'F':'点名 X速度(cm/s) Y速度 Z速度 X频率(Hz) Y频率 Z频率',
    'G':'点名 测线长度(mm)',
    'H':'请上传Excel文件（.xlsx/.xls），或粘贴矩阵数据（Tab分隔）',
    'I':'测点对 实测距离(mm) → 如 A-B 1234.56'
  };
  $('importHint').innerHTML=hints[fmt]||'';
  $('importData').placeholder=placeholders[fmt]||'';
}

function importData(){
  const pjId=$('importProject').value,date=$('importDate').value,fmt=$('importFormat').value,isCum=$('importCumulative').checked;
  // For format H from Excel, use matrixData from dataset
  var raw;
  if(fmt==='H'){
    var mData=$('importData').dataset.matrixData;
    if(mData){raw=mData;}else{raw=$('importData').value.trim();}
  }else{raw=$('importData').value.trim();}
  if(!pjId||!date||!raw){toast('请填写完整信息','error');return;}
  const lines=raw.split('\n').filter(l=>l.trim()),key=pjId+'_'+date;
  let records=[],count=0;

  try{
    if(fmt==='A'){
      // Get baseline - from type config, or manual input
      let bl=null,calcMode='offset';
      if($('importBaselineSource').value==='manual'){
        bl={x0:parseFloat($('manX0').value),y0:parseFloat($('manY0').value),x1:parseFloat($('manX1').value),y1:parseFloat($('manY1').value)};
        calcMode=$('importCalcMode').value;
      }else{
        const typeName='displacement';
        bl=getBaselineForType(pjId,typeName);
        calcMode=$('importCalcMode').value;
      }
      if(!bl||isNaN(bl.x0)){toast('基线参数无效，请先配置基线','error');return;}

      lines.forEach(line=>{
        const parts=line.trim().split(/[\t ]+/);
        if(parts.length<7)return;
        const ix=parseFloat(parts[1]),iy=parseFloat(parts[2]),iz=parseFloat(parts[3]);
        const cx=parseFloat(parts[4]),cy=parseFloat(parts[5]),cz=parseFloat(parts[6]);
        const result=calcDisplacement(ix,iy,iz,cx,cy,cz,bl,calcMode);
        let cumDisp=result.dDisp,cumSettle=result.settle;
        if(isCum){
          var prevKeys=Object.keys(appData.measurements||{}).filter(function(k){return k.startsWith(pjId+'_')&&k!==key;}).sort();
          if(prevKeys.length>0){
            var prevRecords=appData.measurements[prevKeys[prevKeys.length-1]];
            var prev=prevRecords.find(function(r){return r.point===parts[0];});
            if(prev){cumDisp=parseFloat((prev.cumDisp+result.dDisp).toFixed(2));cumSettle=parseFloat(((prev.cumSettle!=null?prev.cumSettle+result.settle:result.settle)).toFixed(2));}
            else{
              var hb=getLatestHistCum(pjId,parts[0]);
              if(hb){cumDisp=parseFloat((hb.cumDisp+result.dDisp).toFixed(2));cumSettle=hb.cumSettle!=null?parseFloat((hb.cumSettle+result.settle).toFixed(2)):result.settle;}
            }
          }else{
            var hb=getLatestHistCum(pjId,parts[0]);
            if(hb){cumDisp=parseFloat((hb.cumDisp+result.dDisp).toFixed(2));cumSettle=hb.cumSettle!=null?parseFloat((hb.cumSettle+result.settle).toFixed(2)):result.settle;}
          }
        }
        records.push({point:parts[0],ix,iy,iz,cx,cy,cz,dInit:result.dInit,dCurr:result.dCurr,disp:result.dDisp,settle:result.settle,cumDisp,cumSettle,calcMode});
        count++;
      });
      if(!appData.measurements)appData.measurements={};
      appData.measurements[key]=records;
    }else if(fmt==='B'){lines.forEach(line=>{const parts=line.trim().split(/[\t ]+/);if(parts.length<3)return;const hi=parseFloat(parts[1]),hc=parseFloat(parts[2]),settle=parseFloat(((hc-hi)*1000).toFixed(2));records.push({point:parts[0],hi,hc,settle,cumSettle:settle});count++;});if(!appData.measurements)appData.measurements={};appData.measurements[key]=records;}
    else if(fmt==='C'){lines.forEach(line=>{const parts=line.trim().split(/[\t ]+/);if(parts.length<3)return;records.push({hole:parts[0],depth:parseFloat(parts[1]),cumDisp:parseFloat(parts[2])});count++;});if(!appData.inclinometerData)appData.inclinometerData={};appData.inclinometerData[key]=records;}
    else if(fmt==='D'){lines.forEach(line=>{const parts=line.trim().split(/[\t ]+/);if(parts.length<2)return;const stress=parseFloat(parts[1]),status=parts[2]||(stress>=0?'拉':'压');records.push({point:parts[0],stress,status});count++;});if(!appData.anchorStress)appData.anchorStress={};appData.anchorStress[key]=records;}
    else if(fmt==='E'){lines.forEach(line=>{const parts=line.trim().split(/[\t ]+/);if(parts.length<2)return;records.push({point:parts[0],level:parseFloat(parts[1])});count++;});if(!appData.waterLevel)appData.waterLevel={};appData.waterLevel[key]=records;}
    else if(fmt==='F'){lines.forEach(line=>{const parts=line.trim().split(/[\t ]+/);if(parts.length<7)return;records.push({point:parts[0],chX:parseFloat(parts[1]),chY:parseFloat(parts[2]),chZ:parseFloat(parts[3]),freqX:parseFloat(parts[4]),freqY:parseFloat(parts[5]),freqZ:parseFloat(parts[6])});count++;});if(!appData.blastVibration)appData.blastVibration={};appData.blastVibration[key]=records;}
    else if(fmt==='G'){lines.forEach(line=>{const parts=line.trim().split(/[\t ]+/);if(parts.length<2)return;records.push({point:parts[0],length:parseFloat(parts[1])});count++;});if(!appData.convergence)appData.convergence={};appData.convergence[key]=records;}
    else if(fmt==='H'){
      if(raw.startsWith('{') || raw.startsWith('[')){
        var matrixData=JSON.parse(raw);
        if(!appData.incData)appData.incData={};
        if(!appData.incData[pjId])appData.incData[pjId]=[];
        var dates=matrixData.dates||[];
        (matrixData.rows||[]).forEach(function(row){
          var depth=parseFloat(row.depth);
          var dateObj={};
          (row.values||[]).forEach(function(v,i){
            if(i<dates.length)dateObj[dates[i]]=parseFloat(v);
          });
          appData.incData[pjId].push({depth:depth,dates:dateObj});
          count++;
        });
        // Build preview records
        records=appData.incData[pjId].map(function(d){return {depth:d.depth,dates:d.dates};});
      }else{
        var dateHeader=lines[0];lines=lines.slice(1);
        var dateCols=dateHeader.trim().split(/[\t ]+/).slice(1);
        if(!appData.incData)appData.incData={};
        if(!appData.incData[pjId])appData.incData[pjId]=[];
        var previewRecords=[];
        lines.forEach(function(line){
          var parts=line.trim().split(/[\t ]+/);if(parts.length<2)return;
          var depth=parseFloat(parts[0]);
          var dateObj={};
          for(var i=1;i<parts.length&&(i-1)<dateCols.length;i++){
            dateObj[dateCols[i-1]]=parseFloat(parts[i]);
          }
          appData.incData[pjId].push({depth:depth,dates:dateObj});
          previewRecords.push({depth:depth,dates:dateObj});
          count++;
        });
        records=previewRecords;
      }
    }
    else if(fmt==='I'){
      var convPreview=[];
      lines.forEach(function(line){
        var parts=line.trim().split(/[\t ]+/);if(parts.length<2)return;
        var pointPair=parts[0],distance=parseFloat(parts[1]);
        if(!appData.convData)appData.convData={};
        if(!appData.convData[pjId])appData.convData[pjId]=[];
        var existing=appData.convData[pjId].find(function(x){return x.pointPair===pointPair;});
        if(existing){existing.records.push({date:date,distance:distance});}
        else{var entry={pointPair:pointPair,records:[{date:date,distance:distance}]};appData.convData[pjId].push(entry);existing=entry;}
        convPreview.push(existing);
        count++;
      });
      records=convPreview;
    }
    saveData(appData);
    const typeNames={D:'锚杆应力',E:'地下水位',F:'爆破振动',G:'收敛监测',H:'测斜矩阵',I:'收敛测线',A:'位移+沉降',B:'沉降',C:'测斜'};
    toast('成功导入 '+count+' 条'+((typeNames[fmt])||'')+'数据','success');
    addOperationLog('数据导入','格式'+fmt+' '+count+'条 → '+pjId+(fmt==='A'?' ('+($('importCalcMode').value==='chainage'?'桩号法':'偏距法')+')':''));
    renderImportPreview(records,fmt);
  }catch(e){toast('导入失败: '+e.message,'error');}
}

function renderImportPreview(records,fmt){
  if(!records||records.length===0){$('importPreview').innerHTML='';return;}
  const sample=records.slice(0,20);let cols=[],html='';
  if(fmt==='A')cols=['点名','X初始','Y初始','Z初始','X当前','Y当前','Z当前','位移mm','沉降mm','累计位移','累计沉降'];
  else if(fmt==='D')cols=['点名','应力(MPa)','状态'];
  else if(fmt==='E')cols=['点名','水位(m)'];
  else if(fmt==='F')cols=['点名','CH_X(cm/s)','CH_Y','CH_Z','Freq_X','Freq_Y','Freq_Z'];
  else if(fmt==='G')cols=['点名','测线长度(mm)'];
  else if(fmt==='H'){
    var sample0=sample[0];var dateKeys=sample0&&sample0.dates?Object.keys(sample0.dates).sort():[];
    cols=['深度(m)'].concat(dateKeys);
    html='<table><thead><tr>'+cols.map(function(c){return '<th>'+c+'</th>';}).join('')+'</tr></thead><tbody>';
    sample.forEach(function(r){
      html+='<tr><td>'+r.depth+'</td>';
      dateKeys.forEach(function(d){html+='<td>'+(r.dates&&r.dates[d]!=null?r.dates[d].toFixed(2):'-')+'</td>';});
      html+='</tr>';
    });
    html+='</tbody></table>';
    if(records.length>20)html+='<div style="padding:8px;color:#999;text-align:center">...共 '+records.length+' 条，仅显示前20条</div>';
    $('importPreview').innerHTML=html;return;
  }
  else if(fmt==='I'){
    cols=['测点对','最近距离(mm)','累计变化(mm)'];
    html='<table><thead><tr>'+cols.map(function(c){return '<th>'+c+'</th>';}).join('')+'</tr></thead><tbody>';
    sample.forEach(function(r){
      var recs=r.records||[];if(recs.length===0)return;
      var firstDist=recs[0].distance,lastDist=recs[recs.length-1].distance;
      var cumChange=(firstDist!=null&&lastDist!=null)?(lastDist-firstDist).toFixed(2):'-';
      html+='<tr><td>'+r.pointPair+'</td><td>'+lastDist+'</td><td>'+cumChange+'</td></tr>';
    });
    html+='</tbody></table>';
    if(records.length>20)html+='<div style="padding:8px;color:#999;text-align:center">...共 '+records.length+' 条，仅显示前20条</div>';
    $('importPreview').innerHTML=html;return;
  }
  else cols=['点名','深度(m)','位移(mm)'];
  html='<table><thead><tr>'+cols.map(c=>'<th>'+c+'</th>').join('')+'</tr></thead><tbody>';
  sample.forEach(r=>{
    html+='<tr>';
    if(fmt==='A')html+='<td>'+r.point+'</td><td>'+r.ix+'</td><td>'+r.iy+'</td><td>'+r.iz+'</td><td>'+r.cx+'</td><td>'+r.cy+'</td><td>'+r.cz+'</td><td>'+r.disp+'</td><td>'+r.settle+'</td><td>'+r.cumDisp+'</td><td>'+r.cumSettle+'</td>';
    else if(fmt==='D')html+='<td>'+r.point+'</td><td>'+r.stress+'</td><td>'+r.status+'</td>';
    else if(fmt==='E')html+='<td>'+r.point+'</td><td>'+r.level+'</td>';
    else if(fmt==='F')html+='<td>'+r.point+'</td><td>'+r.chX+'</td><td>'+r.chY+'</td><td>'+r.chZ+'</td><td>'+r.freqX+'</td><td>'+r.freqY+'</td><td>'+r.freqZ+'</td>';
    else if(fmt==='G')html+='<td>'+r.point+'</td><td>'+r.length+'</td>';
    else html+='<td>'+r.hole+'</td><td>'+r.depth+'</td><td>'+r.cumDisp+'</td>';
    html+='</tr>';
  });
  html+='</tbody></table>';
  if(records.length>20)html+='<div style="padding:8px;color:#999;text-align:center">...共 '+records.length+' 条，仅显示前20条</div>';
  $('importPreview').innerHTML=html;
}

function handleExcelImport(){
  const file=$('excelFile').files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=function(e){
    try{const wb=XLSX.read(e.target.result,{type:'array'});const ws=wb.Sheets[wb.SheetNames[0]];const data=XLSX.utils.sheet_to_json(ws,{header:1});
    const fmt=$('importFormat').value;
    if(fmt==='H'){
      // 测斜矩阵：第一行为表头（深度 + 各日期列），后续行为数据
      if(data.length<2){toast('Excel数据行不足','error');return;}
      var headerRow=data[0]||[];
      var dates=headerRow.slice(1); // 跳过"深度"列
      var rows=[];
      for(var i=1;i<data.length;i++){
        var row=data[i];if(!row||row.length<2)continue;
        var depth=parseFloat(row[0]);
        if(isNaN(depth))continue;
        var values=[];
        for(var j=1;j<row.length&&(j-1)<dates.length;j++){
          values.push(row[j]!=null&&row[j]!==''?parseFloat(row[j]):null);
        }
        if(values.length>0)rows.push({depth:depth,values:values});
      }
      var matrixData=JSON.stringify({dates:dates,rows:rows});
      $('importData').value='[测斜矩阵: '+dates.length+'期 x '+rows.length+'层]';
      $('importData').dataset.matrixData=matrixData;
      toast('已解析测斜矩阵：'+dates.length+'个日期 x '+rows.length+'个深度层','info');
    }else{
      const rows=data.filter(r=>r.length>=2).map(r=>r.join('\t'));$('importData').value=rows.join('\n');toast('已从Excel读取 '+rows.length+' 行','info');
    }}catch(err){toast('Excel解析失败: '+err.message,'error');}
  };reader.readAsArrayBuffer(file);
}

// ==================== PROCESSING ====================
function populateProcessSelect(){
  const sel=$('processProject');sel.innerHTML=(appData.projects||[]).map(p=>'<option value="'+p.id+'">['+p.group+'] '+p.name+'</option>').join('');
  populateProcessDates();
}
function populateProcessDates(){
  const pjId=$('processProject').value,keys=Object.keys(appData.measurements||{}).filter(k=>k.startsWith(pjId+'_')).sort();
  const dates=keys.map(k=>k.replace(pjId+'_',''));const sel=$('processDate');sel.innerHTML=dates.map(d=>'<option value="'+d+'">'+d+'</option>').join('');
  $('trendProject').value=pjId;
  renderPeriodList();
  if(dates.length>0)renderProcess();
  else{$('dispTable').innerHTML='<div class="empty-state">无数据</div>';$('settleTable').innerHTML='';$('alertInfo').innerHTML='';}
}

function renderProcess(){
  const pjId=$('processProject').value,date=$('processDate').value,compare=$('processCompare').value,th=appData.thresholds||DEFAULT_THRESHOLDS;
  if(!pjId||!date)return;
  const key=pjId+'_'+date,records=appData.measurements[key]||[];
  if(records.length===0){$('dispTable').innerHTML='<div class="empty-state">无数据</div>';$('settleTable').innerHTML='';$('alertInfo').innerHTML='';return;}
  let compareDate='';
  if(compare==='prev'){const keys=Object.keys(appData.measurements||{}).filter(k=>k.startsWith(pjId+'_')).sort();const idx=keys.indexOf(key);if(idx>0)compareDate=keys[idx-1].replace(pjId+'_','');}
  else if(compare==='first'){const keys=Object.keys(appData.measurements||{}).filter(k=>k.startsWith(pjId+'_')).sort();if(keys.length>0)compareDate=keys[0].replace(pjId+'_','');}
  else{compareDate=$('processCompareDate').value;}

  const calcModeInfo=records.length>0&&records[0].calcMode ? (' ('+(records[0].calcMode==='chainage'?'桩号法':'偏距法')+')') : '';

  if(isEditing&&editingDate===date){
    // EDIT MODE: render input fields
    let dispHTML='<table><thead><tr><th>测点</th><th>本期位移'+calcModeInfo+'</th><th>累计位移</th><th>本期沉降</th><th>累计沉降</th><th>间隔天数</th></tr></thead><tbody>';
    let settleHTML='';
    records.forEach(function(r,idx){
      dispHTML+='<tr><td><input type="text" value="'+r.point+'" style="width:80px" data-field="point"></td><td><input type="number" step="0.01" value="'+(r.disp||0)+'" style="width:80px" data-field="disp"></td><td><input type="number" step="0.01" value="'+(r.cumDisp||0)+'" style="width:80px" data-field="cumDisp"></td><td><input type="number" step="0.01" value="'+(r.settle||0)+'" style="width:80px" data-field="settle"></td><td><input type="number" step="0.01" value="'+(r.cumSettle||0)+'" style="width:80px" data-field="cumSettle"></td><td><input type="number" step="1" value="'+(r.interval||0)+'" style="width:60px" data-field="interval"></td></tr>';
    });
    dispHTML+='</tbody></table>';
    $('dispTable').innerHTML=dispHTML;
    $('settleTable').innerHTML='';
    $('alertInfo').innerHTML='<span style="color:var(--primary)">编辑模式：修改数值后点击「保存修改」</span>';
    return;
  }

  // Normal view mode
  let dispHTML='<table><thead><tr><th>测点</th><th>本期位移'+calcModeInfo+'</th><th>累计位移</th>';
  if(compareDate&&compareDate!==date)dispHTML+='<th>对比期位移</th><th>变化量</th>';
  dispHTML+='<th>速率(mm/d)</th><th>预警</th></tr></thead><tbody>';
  let settleHTML='<table><thead><tr><th>测点</th><th>本期沉降</th><th>累计沉降</th>';
  if(compareDate&&compareDate!==date)settleHTML+='<th>对比期沉降</th><th>变化量</th>';
  settleHTML+='<th>速率(mm/d)</th><th>预警</th></tr></thead><tbody>';
  let alerts=[];
  records.forEach(r=>{
    const cumDisp=r.cumDisp||0,cumSettle=r.cumSettle||0,rateDisp=parseFloat((r.disp/7).toFixed(2)),rateSettle=parseFloat(((r.settle||0)/7).toFixed(2));
    const dispClass=Math.abs(cumDisp)>=th.cum_red?'alert-row':Math.abs(cumDisp)>=th.cum_orange?'alert-row':'';
    const settleClass=Math.abs(cumSettle)>=th.settle_red?'alert-row':Math.abs(cumSettle)>=th.settle_orange?'alert-row':'';
    const dispAlert=Math.abs(cumDisp)>=th.cum_red?'red':Math.abs(cumDisp)>=th.cum_orange?'orange':Math.abs(cumDisp)>=th.cum_yellow?'yellow':'';
    const settleAlert=Math.abs(cumSettle)>=th.settle_red?'red':Math.abs(cumSettle)>=th.settle_orange?'orange':Math.abs(cumSettle)>=th.settle_yellow?'yellow':'';
    if(dispAlert)alerts.push({point:r.point,type:'位移',value:cumDisp,level:dispAlert});
    if(settleAlert)alerts.push({point:r.point,type:'沉降',value:cumSettle,level:settleAlert});
    dispHTML+='<tr class="'+dispClass+'"><td>'+r.point+'</td><td>'+r.disp+'</td><td class="'+(dispAlert?'alert-cell':'')+'">'+cumDisp+'</td>';
    if(compareDate&&compareDate!==date){const cRecords=appData.measurements[pjId+'_'+compareDate]||[];const cr=cRecords.find(x=>x.point===r.point);const cDisp=cr?cr.disp:'-';const delta=cr?parseFloat((r.disp-cr.disp).toFixed(2)):'-';dispHTML+='<td>'+cDisp+'</td><td>'+delta+'</td>';}
    dispHTML+='<td>'+rateDisp+'</td><td>'+dispAlert+'</td></tr>';
    settleHTML+='<tr class="'+settleClass+'"><td>'+r.point+'</td><td>'+(r.settle||'-')+'</td><td class="'+(settleAlert?'alert-cell':'')+'">'+cumSettle+'</td>';
    if(compareDate&&compareDate!==date){const cRecords=appData.measurements[pjId+'_'+compareDate]||[];const cr=cRecords.find(x=>x.point===r.point);const cSettle=cr&&cr.settle!=null?cr.settle:'-';const sDelta=cr&&cr.settle!=null?parseFloat((r.settle-cr.settle).toFixed(2)):'-';settleHTML+='<td>'+cSettle+'</td><td>'+sDelta+'</td>';}
    settleHTML+='<td>'+rateSettle+'</td><td>'+settleAlert+'</td></tr>';
  });
  dispHTML+='</tbody></table>';$('dispTable').innerHTML=dispHTML;$('settleTable').innerHTML=settleHTML;
  $('alertInfo').innerHTML=alerts.length>0?alerts.map(a=>'<span class="badge badge-'+(a.level==='red'?'red':'orange')+'">'+a.point+': '+a.type+'='+a.value+'mm ('+a.level+')</span> ').join(''):'<span class="badge badge-green">全部正常</span>';
  populateInclinoHoles();renderTrendChart();
  renderInclinoMatrix();renderConvergenceProcess();
}

// ==================== PERIOD MANAGEMENT ====================
var isEditing=false,editingDate=null;

function renderPeriodList(){
  var pjId=$('processProject').value;if(!pjId){$('periodList').innerHTML='';return;}
  var keys=Object.keys(appData.measurements||{}).filter(function(k){return k.startsWith(pjId+'_');}).sort().reverse();
  if(keys.length===0){$('periodList').innerHTML='<div class="empty-state">暂无导入的期次数据</div>';return;}
  var html='<table><thead><tr><th>期次日期</th><th>监测点数</th><th style="width:120px">操作</th></tr></thead><tbody>';
  keys.forEach(function(k){
    var date=k.replace(pjId+'_','');
    var count=(appData.measurements[k]||[]).length;
    html+='<tr><td><a href="javascript:void(0)" style="color:var(--primary);text-decoration:none;font-weight:bold" onclick="loadPeriod(\''+date+'\')">'+date+'</a></td><td>'+count+' 个测点</td><td><button class="btn btn-xs btn-outline" onclick="editPeriod(\''+date+'\')" style="margin-right:4px">编辑</button><button class="btn btn-xs btn-outline" style="color:var(--danger);border-color:var(--danger)" onclick="deletePeriod(\''+date+'\')">删除</button></td></tr>';
  });
  html+='</tbody></table>';
  $('periodList').innerHTML=html;
}

function loadPeriod(date){
  isEditing=false;editingDate=null;
  $('processDate').value=date;
  $('editModeBar').style.display='none';
  renderProcess();
}

function editPeriod(date){
  isEditing=true;editingDate=date;
  $('processDate').value=date;
  renderProcess();
  // Show edit bar with save/cancel
  $('editModeBar').style.display='block';
}

function saveEditedPeriod(){
  try{
    if(!isEditing||!editingDate)return;
    var pjId=$('processProject').value;
    var key=pjId+'_'+editingDate;
    var origRecords=appData.measurements[key]||[];
    console.log('saveEditedPeriod: key='+key+' origCount='+origRecords.length);
    var updated=[];
    var rows=document.querySelectorAll('#dispTable tbody tr');
    rows.forEach(function(row,idx){
      var inputs=row.querySelectorAll('input');
      if(inputs.length===0)return;
      var rec=idx<origRecords.length?Object.assign({},origRecords[idx]):{point:'',disp:0,cumDisp:0,settle:0,cumSettle:0,interval:0};
      inputs.forEach(function(inp){
        var field=inp.getAttribute('data-field');
        if(!field)return;
        if(field==='point')rec[field]=inp.value;
        else rec[field]=parseFloat(inp.value)||0;
      });
      updated.push(rec);
    });
    if(updated.length===0){toast('没有读取到编辑数据','error');return;}
    console.log('saveEditedPeriod: updatedCount='+updated.length+' first='+updated[0].point+' disp='+updated[0].disp);
    appData.measurements[key]=updated;
    console.log('saveEditedPeriod: before saveData, key exists='+!!appData.measurements[key]+' len='+appData.measurements[key].length);
    saveData(appData);
    isEditing=false;editingDate=null;
    $('editModeBar').style.display='none';
    populateProcessDates();
    console.log('saveEditedPeriod: done, rendering complete');
    toast('已保存 '+updated.length+' 条记录','success');
  }catch(e){
    console.error('saveEditedPeriod ERROR:',e);
    toast('保存失败: '+e.message,'error');
  }
}

function cancelEdit(){
  isEditing=false;editingDate=null;
  $('editModeBar').style.display='none';
  renderProcess();
}

function deletePeriod(date){
  if(!confirm('确定删除 '+date+' 的全部监测数据？此操作不可恢复。'))return;
  var pjId=$('processProject').value;
  var key=pjId+'_'+date;
  delete appData.measurements[key];
  saveData(appData);
  renderPeriodList();
  $('processDate').value='';
  renderProcess();
}

// ==================== INCLINOMETER ====================
function populateInclinoHoles(){
  const pjId=$('processProject').value,sel=$('inclinoHole'),holes=new Set();
  const iKeys=Object.keys(appData.inclinometerData||{}).filter(k=>k.startsWith(pjId+'_'));
  iKeys.forEach(k=>{(appData.inclinometerData[k]||[]).forEach(r=>{if(r.hole)holes.add(r.hole);});});
  sel.innerHTML=Array.from(holes).sort().map(h=>'<option value="'+h+'">'+h+'</option>').join('');
  if(holes.size>0)renderInclinoChart();
}
function renderInclinoChart(){
  const pjId=$('processProject').value,hole=$('inclinoHole').value;if(!hole)return;
  const iKeys=Object.keys(appData.inclinometerData||{}).filter(k=>k.startsWith(pjId+'_')).sort(),datasets=[];
  iKeys.forEach((key,idx)=>{const date=key.replace(pjId+'_',''),records=(appData.inclinometerData[key]||[]).filter(r=>r.hole===hole);if(records.length===0)return;records.sort((a,b)=>a.depth-b.depth);datasets.push({label:date,data:records.map(r=>({x:r.cumDisp,y:r.depth})),borderColor:COLORS28[idx%COLORS28.length],backgroundColor:'transparent',borderWidth:2,pointRadius:4});});
  const ctx=$('inclinoCanvas'),existing=Chart.getChart(ctx);if(existing)existing.destroy();if(datasets.length===0)return;
  new Chart(ctx,{type:'line',data:{datasets},options:{responsive:true,maintainAspectRatio:false,scales:{x:{title:{display:true,text:'累计位移 (mm)'},type:'linear',position:'bottom'},y:{title:{display:true,text:'深度 (m)'},reverse:true}},plugins:{title:{display:true,text:'测斜管 '+hole+' 深度-位移剖面图'},legend:{position:'bottom'}}}});
}


// ==================== INCLINO MATRIX (测斜矩阵) ====================
function renderInclinoMatrix(){
  var pjId=$("processProject").value;var matrix=appData.incData&&appData.incData[pjId];
  if(!$("inclinoMatrixSection"))return;
  if(!matrix||matrix.length===0){$("inclinoMatrixSection").innerHTML="";return;}
  var allDates=[];matrix.forEach(function(d){Object.keys(d.dates).forEach(function(dt){if(allDates.indexOf(dt)<0)allDates.push(dt);});});
  allDates.sort();matrix.sort(function(a,b){return a.depth-b.depth;});var depths=matrix.map(function(d){return d.depth;});
  var cvs=$("inclinoMatrixCanvas");if(cvs){
    var existing=Chart.getChart(cvs);if(existing)existing.destroy();
    var datasets=allDates.map(function(date,idx){
      var color=COLORS28[idx%COLORS28.length];
      return {label:date,data:matrix.map(function(d){return d.dates[date]!=null?d.dates[date]:null;}),borderColor:color,backgroundColor:"transparent",borderWidth:1.5,pointRadius:0,pointHoverRadius:4,tension:0,fill:false,spanGaps:false};
    });
    new Chart(cvs,{type:"line",data:{labels:depths.map(function(d){return d+"m";}),datasets:datasets},options:{responsive:true,maintainAspectRatio:false,scales:{x:{title:{display:true,text:"累计变化量 (mm)"},type:"linear",position:"bottom"},y:{title:{display:true,text:"深度 (m)"},reverse:true}},plugins:{title:{display:true,text:"测斜管 深度-变化量剖面曲线"},legend:{position:"bottom",labels:{boxWidth:10,font:{size:8},padding:3}}}}});
  }
  var tbl=$("inclinoMatrixTable");if(tbl){
    var html="<thead><tr><th>日期</th>";
    depths.forEach(function(d){html+="<th>"+d+"m</th>";});html+="</tr></thead><tbody>";
    allDates.forEach(function(date){html+="<tr><td>"+date+"</td>";
      depths.forEach(function(depth){var row=matrix.find(function(r){return r.depth===depth;});var val=row&&row.dates[date]!=null?row.dates[date]:null;var cls="";
        if(val!=null){var maxAbs=0;depths.forEach(function(d2){var r2=matrix.find(function(r){return r.depth===d2;});var v2=r2&&r2.dates[date]!=null?r2.dates[date]:null;if(v2!=null&&Math.abs(v2)>maxAbs)maxAbs=Math.abs(v2);});if(Math.abs(val)===maxAbs&&maxAbs>0)cls=" style=\"color:red\"";}
        html+="<td"+cls+">"+(val!=null?val.toFixed(2):"-")+"</td>";});html+="</tr>";});html+="</tbody>";tbl.innerHTML=html;
  }
}
// ==================== CONVERGENCE (收敛监测) ====================
function renderConvergenceProcess(){
  var pjId=$("processProject").value;var convList=appData.convData&&appData.convData[pjId];
  if(!$("convTable"))return;if(!convList||convList.length===0){$("convTable").innerHTML="";return;}
  var allDates=[];convList.forEach(function(cp){(cp.records||[]).forEach(function(r){if(allDates.indexOf(r.date)<0)allDates.push(r.date);});});allDates.sort();
  var summary=[];convList.forEach(function(cp){
    var recs=cp.records||[];if(recs.length===0)return;recs.sort(function(a,b){return a.date.localeCompare(b.date);});
    var firstDist=recs[0].distance,lastRec=recs[recs.length-1],lastDist=lastRec.distance;
    var cumChange=parseFloat((lastDist-firstDist).toFixed(2)),monthlyChange=null,monthlyRate=null;
    if(recs.length>=2){var prevRec=recs[recs.length-2];monthlyChange=parseFloat((lastDist-prevRec.distance).toFixed(2));var days=Math.max(1,Math.round((new Date(lastRec.date)-new Date(prevRec.date))/86400000));monthlyRate=parseFloat((monthlyChange/days).toFixed(2));}
    summary.push({pointPair:cp.pointPair,cumChange:cumChange,monthlyChange:monthlyChange,monthlyRate:monthlyRate,records:recs});
  });if(summary.length===0){$("convTable").innerHTML="";return;}
  var maxCum=0,maxRate=0;summary.forEach(function(s){if(Math.abs(s.cumChange)>maxCum)maxCum=Math.abs(s.cumChange);if(Math.abs(s.monthlyRate||0)>maxRate)maxRate=Math.abs(s.monthlyRate||0);});
  var html="<div style=\"margin-bottom:16px;line-height:1.8;font-size:14px;\"><strong>收敛监测说明</strong><br>";
  html+="监测时段："+allDates[0]+" 至 "+allDates[allDates.length-1]+"，共 "+allDates.length+" 期。<br>";
  var mp=summary.reduce(function(a,b){return Math.abs(a.cumChange)>=Math.abs(b.cumChange)?a:b;});
  html+="最大累计变化："+mp.pointPair+"（"+mp.cumChange+" mm）。<br>";
  mp=summary.reduce(function(a,b){return Math.abs(a.monthlyRate||0)>=Math.abs(b.monthlyRate||0)?a:b;});
  html+="最大速率："+mp.pointPair+"（"+mp.monthlyRate+" mm/d）。</div>";
  html+="<div style=\"margin-bottom:8px;\"><strong>表1 收敛变形监测成果（多期对比）</strong></div>";
  html+="<table style=\"width:100%;border-collapse:collapse\"><thead><tr><th>测点对</th>";
  allDates.forEach(function(d){html+="<th>"+d+"</th>";});html+="</tr></thead><tbody>";
  summary.forEach(function(s){html+="<tr><td>"+s.pointPair+"</td>";var dm={};s.records.forEach(function(r){dm[r.date]=r.distance;});
    allDates.forEach(function(d){html+="<td>"+(dm[d]!=null?dm[d].toFixed(2):"-")+"</td>";});html+="</tr>";});html+="</tbody></table>";
  html+="<div style=\"margin:16px 0 8px 0;\"><strong>表2 收敛点变形监测成果（测点汇总）</strong></div>";
  html+="<table style=\"width:100%;border-collapse:collapse\"><thead><tr><th>点号</th><th>本月变化量(mm)</th><th>累计位移(mm)</th><th>本月变化速率(mm/d)</th></tr></thead><tbody>";
  summary.forEach(function(s){var cRed=Math.abs(s.cumChange)===maxCum&&maxCum>0,rRed=Math.abs(s.monthlyRate||0)===maxRate&&maxRate>0;
    html+="<tr><td>"+s.pointPair+"</td><td"+(rRed?" style=\"color:red\"":"")+">"+(s.monthlyChange!=null?s.monthlyChange.toFixed(2):"-")+"</td><td"+(cRed?" style=\"color:red\"":"")+">"+s.cumChange.toFixed(2)+"</td><td"+(rRed?" style=\"color:red\"":"")+">"+(s.monthlyRate!=null?s.monthlyRate.toFixed(2):"-")+"</td></tr>";});html+="</tbody></table>";
  $("convTable").innerHTML=html;
}

// ==================== TREND CHART ====================
function populateTrendSelect(){const sel=$('trendProject');sel.innerHTML=(appData.projects||[]).map(p=>'<option value="'+p.id+'">'+p.name+'</option>').join('');}
function buildTrendData(pjId){
  const allDatesSet=new Set(),pointValuesMap={};
  const mKeys=Object.keys(appData.measurements||{}).filter(k=>k.startsWith(pjId+'_')).sort();
  mKeys.forEach(key=>{const date=key.replace(pjId+'_','');allDatesSet.add(date);const records=appData.measurements[key];if(!records||records.length===0)return;records.forEach(r=>{if(!r.point)return;if(!pointValuesMap[r.point])pointValuesMap[r.point]={};const v=r.cumDisp!=null?r.cumDisp:(r.disp!=null?r.disp:null);if(v!=null)pointValuesMap[r.point][date]=parseFloat(v.toFixed(2));});});
  return {allDates:Array.from(allDatesSet).sort(),pointValuesMap};
}
function buildTrendDatasets(allDates,pointValuesMap){
  const pointList=Object.keys(pointValuesMap).sort(),datasets=[];
  pointList.forEach((point,idx)=>{const color=COLORS28[idx%COLORS28.length],data=allDates.map(date=>pointValuesMap[point][date]??null);datasets.push({label:point,data,borderColor:color,backgroundColor:color,borderWidth:1.5,pointRadius:0,pointHoverRadius:4,tension:0,fill:false,spanGaps:false});});
  return datasets;
}
function renderTrendChart(){
  const pjId=$('processProject').value;if(!pjId)return;
  const {allDates,pointValuesMap}=buildTrendData(pjId),datasets=buildTrendDatasets(allDates,pointValuesMap);
  const ctx=$('trendCanvas'),existing=Chart.getChart(ctx);if(existing)existing.destroy();if(datasets.length===0)return;
  new Chart(ctx,{type:'line',data:{labels:allDates,datasets},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'nearest',intersect:false},plugins:{title:{display:true,text:'累计位移趋势图 ('+datasets.length+'个测点)'},legend:{position:'top',labels:{boxWidth:12,font:{size:10},padding:6}}},scales:{x:{title:{display:true,text:'日期'},grid:{display:true,color:'rgba(0,0,0,0.06)'}},y:{title:{display:true,text:'累计位移 (mm)'},grid:{color:'rgba(0,0,0,0.06)'}}}}});
}

// ==================== HISTORY ====================
function populateHistorySelect(){const sel=$('histProject');sel.innerHTML=(appData.projects||[]).map(p=>'<option value="'+p.id+'">['+p.group+'] '+p.name+'</option>').join('');}
function renderHistPanel(){
  const pjId=$('histProject').value,hist=appData.historyCumData[pjId]||{};$('histDate').value=formatDate(new Date());
  let html='';Object.keys(hist).sort().forEach(point=>{(hist[point]||[]).forEach(e=>{html+='<tr><td>'+point+'</td><td>'+e.date+'</td><td>'+e.cumDisp+'</td><td>'+(e.cumSettle!=null?e.cumSettle:'-')+'</td><td><button class="btn btn-sm" style="background:#E8F1FB;color:var(--primary);margin-right:4px" onclick="editHistRecord(\''+pjId+'\',\''+point+'\',\''+e.date+'\')">编辑</button><button class="btn btn-sm btn-danger" onclick="deleteHistRecord(\''+pjId+'\',\''+point+'\',\''+e.date+'\')">删除</button></td></tr>';});});
  $('histTable').querySelector('tbody').innerHTML=html||'<tr><td colspan="5" style="text-align:center;color:#999">暂无历史累计数据</td></tr>';
}
var histEditState={pjId:null,point:null,date:null};

function downloadHistTemplate(){
  var ws_data=[['测点编号','日期','累计位移(mm)','累计沉降(mm)'],['CN3','2025-01-15',12.35,-5.20]];
  var ws=XLSX.utils.aoa_to_sheet(ws_data);
  ws['!cols']=[{wch:12},{wch:14},{wch:16},{wch:16}];
  var wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'历史累计数据导入模板');
  XLSX.writeFile(wb,'历史累计数据导入模板.xlsx');
}

function getLatestHistCum(pjId,point){
  if(!appData.historyCumData||!appData.historyCumData[pjId]||!appData.historyCumData[pjId][point])return null;
  var entries=appData.historyCumData[pjId][point];
  if(entries.length===0)return null;
  var latest=entries.reduce(function(a,b){return a.date>b.date?a:b;});
  return {cumDisp:latest.cumDisp||0,cumSettle:latest.cumSettle||0};
}

function handleHistExcel(){
  var file=$('histExcel').files[0];if(!file)return;
  var reader=new FileReader();
  reader.onload=function(e){
    try{
      var wb=XLSX.read(e.target.result,{type:'array'});
      var ws=wb.Sheets[wb.SheetNames[0]];
      var data=XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
      var pjId=$('histProject').value;
      if(!pjId){toast('请先选择子项目','error');return;}

      var headerRow=-1, colMap={};
      for(var i=0;i<Math.min(5,data.length);i++){
        var row=data[i];
        var hasPoint=row.some(function(c){var s=String(c).trim();return s.includes('测点')||s.includes('编号')||s==='点名';});
        var hasDate=row.some(function(c){return String(c).includes('日期');});
        if(hasPoint&&hasDate){headerRow=i;break;}
      }

      if(headerRow>=0){
        var hRow=data[headerRow];
        for(var c=0;c<hRow.length;c++){
          var h=String(hRow[c]).trim();
          if(h.includes('测点')||h.includes('点名')||h.includes('编号'))colMap.point=c;
          else if(h.includes('日期'))colMap.date=c;
          else if(h.includes('位移')||h.includes('disp'))colMap.cumDisp=c;
          else if(h.includes('沉降')||h.includes('settle'))colMap.cumSettle=c;
        }
      }

      if(!colMap.point&&data.length>0&&data[0].length>=3){
        colMap.point=0;colMap.date=1;
        if(data[0].length>=4){colMap.cumDisp=2;colMap.cumSettle=3;}
        else{colMap.cumDisp=2;}
        headerRow=0;
      }

      if(colMap.point==null||colMap.date==null||colMap.cumDisp==null&&colMap.cumSettle==null){
        toast('无法识别Excel格式，请使用下载模板','error');return;
      }

      var count=0,startRow=headerRow>=0?headerRow+1:0;
      if(!appData.historyCumData)appData.historyCumData={};
      if(!appData.historyCumData[pjId])appData.historyCumData[pjId]={};

      for(var r=startRow;r<data.length;r++){
        var row=data[r];
        var point=String(row[colMap.point]||'').trim();
        var date=String(row[colMap.date]||'').trim();
        if(!point||!date)continue;

        var d=new Date(date);
        if(!isNaN(d.getTime()))date=formatDate(d);

        var cumDisp=colMap.cumDisp!=null?parseFloat(row[colMap.cumDisp]):null;
        var cumSettle=colMap.cumSettle!=null?parseFloat(row[colMap.cumSettle]):null;
        if(isNaN(cumDisp)&&isNaN(cumSettle))continue;

        if(!appData.historyCumData[pjId][point])appData.historyCumData[pjId][point]=[];
        var existing=appData.historyCumData[pjId][point].findIndex(function(e){return e.date===date;});
        var entry={date:date,cumDisp:isNaN(cumDisp)?null:cumDisp,cumSettle:isNaN(cumSettle)?null:cumSettle};
        if(existing>=0)appData.historyCumData[pjId][point][existing]=entry;
        else appData.historyCumData[pjId][point].push(entry);
        count++;
      }

      saveData(appData);renderHistPanel();
      toast('从Excel导入 '+count+' 条历史记录','success');
      addOperationLog('历史数据','Excel导入 '+count+' 条');
    }catch(err){toast('Excel解析失败: '+err.message,'error');}
  };
  reader.readAsArrayBuffer(file);
}

function deleteHistRecord(pjId,point,date){
  if(!confirm('确定删除 '+point+' '+date+' 的历史记录？'))return;
  if(!appData.historyCumData[pjId])return;
  appData.historyCumData[pjId][point]=(appData.historyCumData[pjId][point]||[]).filter(e=>e.date!==date);
  if(appData.historyCumData[pjId][point].length===0)delete appData.historyCumData[pjId][point];
  saveData(appData);renderHistPanel();toast('已删除','info');
}

function editHistRecord(pjId,point,date){
  var entries=appData.historyCumData[pjId]&&appData.historyCumData[pjId][point]||[];
  var entry=entries.find(function(e){return e.date===date;});
  if(!entry)return;
  $('histPoint').value=point;$('histDate').value=date;
  $('histCumDisp').value=entry.cumDisp!=null?entry.cumDisp:'';
  $('histCumSettle').value=entry.cumSettle!=null?entry.cumSettle:'';
  histEditState={pjId:pjId,point:point,date:date};
  $('histEditBar').style.display='block';
  $('histEditTarget').textContent=point+' '+date;
  document.querySelector('#panel-history .card .btn-primary').textContent='更新记录';
  document.querySelector('#panel-history .card .btn-primary').style.background='var(--warning)';
  scrollToElement($('histPoint'));
}

function cancelHistEdit(){
  histEditState={pjId:null,point:null,date:null};
  $('histEditBar').style.display='none';
  $('histPoint').value='';$('histDate').value=formatDate(new Date());
  $('histCumDisp').value='';$('histCumSettle').value='';
  var addBtn=document.querySelector('#panel-history .card .btn-primary');
  addBtn.textContent='添加记录';addBtn.style.background='';
}

function saveHistRecord(){
  var pjId=$('histProject').value,point=$('histPoint').value.trim(),date=$('histDate').value,cumDisp=parseFloat($('histCumDisp').value),cumSettle=parseFloat($('histCumSettle').value);
  if(!pjId||!point||!date||isNaN(cumDisp)){toast('请填写完整信息','error');return;}
  if(!appData.historyCumData)appData.historyCumData={};

  if(histEditState.pjId&&histEditState.point&&histEditState.date){
    if(appData.historyCumData[histEditState.pjId]&&appData.historyCumData[histEditState.pjId][histEditState.point]){
      appData.historyCumData[histEditState.pjId][histEditState.point]=appData.historyCumData[histEditState.pjId][histEditState.point].filter(function(e){return e.date!==histEditState.date;});
      if(appData.historyCumData[histEditState.pjId][histEditState.point].length===0)delete appData.historyCumData[histEditState.pjId][histEditState.point];
    }
  }

  if(!appData.historyCumData[pjId])appData.historyCumData[pjId]={};
  if(!appData.historyCumData[pjId][point])appData.historyCumData[pjId][point]=[];

  appData.historyCumData[pjId][point].push({date:date,cumDisp:cumDisp,cumSettle:isNaN(cumSettle)?null:cumSettle});
  saveData(appData);renderHistPanel();cancelHistEdit();
  toast(histEditState.pjId?'记录已更新':'历史记录已添加','success');
  addOperationLog('历史数据',(histEditState.pjId?'更新':'添加')+' '+point+' 历史记录');
}

// ==================== REPORT ====================
function populateReportSelect(){
  const container=$('reportProjects');
  if(!container)return;
  const grouped={};
  (appData.projects||[]).forEach(p=>{
    if(!grouped[p.group])grouped[p.group]=[];
    grouped[p.group].push(p);
  });
  let html='';
  const areaOrder=['矿山加工系统','矿山','物流廊道','陆域堆场','码头平台'];
  const areaColors={'矿山加工系统':'#1a73e8','矿山':'#1a73e8','物流廊道':'#e37400','陆域堆场':'#7b1fa2','码头平台':'#137333'};
  areaOrder.forEach(group=>{
    if(!grouped[group])return;
    html+='<div style="font-weight:600;font-size:13px;color:'+(areaColors[group]||'#555')+';padding:6px 0 2px;margin-top:6px;border-bottom:1px solid #eee">'+group+'</div>';
    grouped[group].forEach(p=>{
      const keys=getProjectDataKeys(p.id);
      const hasData=keys.length>0;
      const totalPeriods=new Set(keys.map(k=>k.date)).size;
      html+='<label style="display:flex;align-items:center;gap:4px;font-size:13px;padding:3px 6px;cursor:pointer;"><input type="checkbox" value="'+p.id+'" onchange="onReportProjectChange(this)">'+p.name+' <span style="font-size:11px;color:#999">('+(hasData?totalPeriods+'期':'无数据')+')</span></label>';
    });
  });
  container.innerHTML=html;
  $('reportDate').value=formatDate(new Date());
}

function selectAllReportProjects(){
  document.querySelectorAll('#reportProjects input[type="checkbox"]:not([disabled])').forEach(cb=>{cb.checked=true;});
}
function deselectAllReportProjects(){
  document.querySelectorAll('#reportProjects input[type="checkbox"]').forEach(cb=>{cb.checked=false;});
}
function onReportProjectChange(cb){}
function toggleReportType(){const type=$('reportType').value;$('reportHint').innerHTML=type==='monthly'?'<strong>月报模式</strong>：包含概述、各区域监测成果分析、巡视检查、存在的主要问题与建议、下月工作计划等7章结构，支持多子项目合并，表格含趋势折线图':'<strong>周报模式</strong>：包含概述、区域成果、巡视检查、问题建议、工作计划等节';}
// ==================== REPORT GENERATION ENGINE ====================
// Helper: get all measurement keys for a project, sorted by date
function getProjectDataKeys(pjId){
  const allKeys=[];
  ['measurements','anchorStress','blastVibration','convergence','waterLevel','inclinometerData'].forEach(store=>{
    const obj=appData[store]||{};
    Object.keys(obj).filter(k=>k.startsWith(pjId+'_')).forEach(k=>allKeys.push({key:k,date:k.replace(pjId+'_',''),store}));
  });
  // include incData dates
  var inc=appData.incData&&appData.incData[pjId];if(inc&&inc.length>0){inc.forEach(function(d){Object.keys(d.dates).forEach(function(dt){allKeys.push({key:'inc_'+pjId,date:dt,store:'incData'});});});}
  var conv=appData.convData&&appData.convData[pjId];if(conv&&conv.length>0){conv.forEach(function(cp){(cp.records||[]).forEach(function(r){allKeys.push({key:'conv_'+pjId+'_'+cp.pointPair,date:r.date,store:'convData'});});});}
  allKeys.sort((a,b)=>a.date.localeCompare(b.date));
  return allKeys;
}

// Helper: get latest measurement date for a project
function getLatestDate(pjId){
  const keys=getProjectDataKeys(pjId);
  return keys.length>0?keys[keys.length-1].date:null;
}

// Helper: build analysis text for displacement/settlement data
function buildAnalysisText(records,projName,latestDate,th){
  const {TextRun}=docx;
  if(!records||records.length===0)return [{text:'暂无监测数据。',bold:false}];
  const dispVals=records.map(r=>Math.abs(r.cumDisp||0)).filter(v=>!isNaN(v));
  const settleVals=records.map(r=>Math.abs(r.cumSettle||0)).filter(v=>!isNaN(v));
  const rateVals=records.map(r=>Math.abs(r.disp||0)).filter(v=>!isNaN(v));
  const runs=[];
  runs.push({text:'截至本期，'+projName,bold:false});
  if(dispVals.length>0){
    const maxDisp=Math.max(...dispVals),maxDispPt=records.find(r=>Math.abs(r.cumDisp||0)===maxDisp);
    runs.push({text:'已测累计最大位移为',bold:false});
    runs.push({text:maxDisp.toFixed(2)+'mm',bold:true});
    if(maxDispPt){runs.push({text:'，位于',bold:false});runs.push({text:maxDispPt.point+'号监测点',bold:true});}
    const maxRate=Math.max(...rateVals),maxRatePt=records.find(r=>Math.abs(r.disp||0)===maxRate);
    runs.push({text:'；本期最大变化量为',bold:false});
    runs.push({text:maxRate.toFixed(2)+'mm',bold:true});
    if(maxRatePt){runs.push({text:'，变化速率为',bold:false});runs.push({text:(maxRate/7).toFixed(2)+'mm/d',bold:true});runs.push({text:'，位于',bold:false});runs.push({text:maxRatePt.point+'号监测点',bold:true});}
  }
  if(settleVals.length>0){
    const maxSettle=Math.max(...settleVals),maxSPt=records.find(r=>Math.abs(r.cumSettle||0)===maxSettle);
    runs.push({text:'。已测累计最大沉降为',bold:false});
    runs.push({text:maxSettle.toFixed(2)+'mm',bold:true});
    if(maxSPt){runs.push({text:'，位于',bold:false});runs.push({text:maxSPt.point+'号监测点',bold:true});}
  }
  // Warning check
  const alerts=records.filter(r=>Math.abs(r.cumDisp||0)>=(th.cum_red||80)||Math.abs(r.cumSettle||0)>=(th.settle_red||50));
  if(alerts.length>0){
    runs.push({text:'。',bold:false});
    runs.push({text:'预警',bold:true,color:'FF0000'});
    runs.push({text:'：'+alerts.map(a=>a.point).join('、')+'号测点超红色警戒值',bold:true,color:'FF0000'});
  }else{
    const warns=records.filter(r=>Math.abs(r.cumDisp||0)>=(th.cum_yellow||30)||Math.abs(r.cumSettle||0)>=(th.settle_yellow||10));
    if(warns.length>0)runs.push({text:'。部分测点超黄色警戒值，需持续关注',bold:false});
    else runs.push({text:'，未超警戒值',bold:false});
  }
  runs.push({text:'。',bold:false});
  return runs;
}

function buildAnalysisParagraph(runs){
  const {Paragraph,TextRun,AlignmentType}=docx;
  const trs=runs.map(r=>new TextRun({
    text:r.text,font:'宋体',size:22,
    bold:r.bold||false,
    color:r.color||undefined
  }));
  return new Paragraph({spacing:{before:100,after:100},children:trs});
}

// Helper: create a bordered table cell
function TCell(text,opts={}){
  const {TableCell,Paragraph,TextRun,AlignmentType,BorderStyle,WidthType}=docx;
  const border={top:{style:BorderStyle.SINGLE,size:1,color:'000000'},bottom:{style:BorderStyle.SINGLE,size:1,color:'000000'},left:{style:BorderStyle.SINGLE,size:1,color:'000000'},right:{style:BorderStyle.SINGLE,size:1,color:'000000'}};
  const trOpts={text:String(text||''),bold:!!opts.header,size:18,font:'宋体'};
  if(opts.color)trOpts.color=opts.color;
  return new TableCell({
    borders:border,
    width:{size:opts.width||1000,type:WidthType.DXA},
    shading:opts.header?{fill:'D9E2F3'}:undefined,
    verticalAlign:'center',
    children:[new Paragraph({
      alignment:opts.center?AlignmentType.CENTER:AlignmentType.LEFT,
      spacing:{before:20,after:20},
      children:[new TextRun(trOpts)]
    })]
  });
}

// Helper: create a full table from headers and rows
function buildDataTable(headers,rows,opts={}){
  const {Table,TableRow,WidthType}=docx;
  const hcells=headers.map(h=>TCell(h,{header:true,center:true,width:opts.colWidth||1200}));
  const allRows=[new TableRow({children:hcells,tableHeader:true})];
  rows.forEach(row=>{
    const cells=row.map(c=>TCell(c,{center:opts.centerCells!==false,width:opts.colWidth||1200}));
    allRows.push(new TableRow({children:cells}));
  });
  return new Table({rows:allRows,width:{size:100,type:WidthType.PERCENTAGE}});
}

// Helper: convergence summary table with red marking for max values
function buildCVSummaryTable(headers,rows,cvSummary,cvMaxCum,cvMaxRate){
  const {Table,TableRow,WidthType}=docx;
  function cvTCell(text,isRed,isHeader,width){
    var children=[new TextRun({text:String(text),size:18,font:'宋体',color:isRed?'FF0000':'000000'})];
    return new docx.TableCell({children:[new Paragraph({alignment:docx.AlignmentType.CENTER,children:children})],width:{size:width||1200,type:WidthType.DXA},
      shading:isHeader?{fill:'D9E2F3'}:undefined});
  }
  var hcells=headers.map(function(h,i){return cvTCell(h,false,true,i===0?1400:1200);});
  var allRows=[new TableRow({children:hcells,tableHeader:true})];
  rows.forEach(function(row,i){
    var s=cvSummary[i],cRed=Math.abs(s.cumChange)===cvMaxCum&&cvMaxCum>0,rRed=Math.abs(s.monthlyRate||0)===cvMaxRate&&cvMaxRate>0;
    var cells=[cvTCell(row[0],false,false,1400),cvTCell(row[1],rRed,false,1200),cvTCell(row[2],cRed,false,1200),cvTCell(row[3],rRed,false,1200)];
    allRows.push(new TableRow({children:cells}));
  });
  return new Table({rows:allRows,width:{size:100,type:WidthType.PERCENTAGE}});
}

// Helper: get area-grouped projects with measurement data
function getReportDataByArea(selectedIds){
  const areas={};
  const areaOrder=['矿山加工系统','矿山','物流廊道','陆域堆场','码头平台'];
  (appData.projects||[]).forEach(p=>{
    if(!selectedIds.includes(p.id))return;
    const keys=getProjectDataKeys(p.id);
    const area=p.group||p.area;
    if(!areas[area])areas[area]={name:area,projects:[]};
    areas[area].projects.push({
      id:p.id,name:p.name,area:p.area||area,desc:p.desc,
      dataKeys:keys,latestDate:keys.length>0?keys[keys.length-1].date:null,
      totalPeriods:new Set(keys.map(k=>k.date)).size
    });
  });
  // Reorder areas
  const ordered={};
  areaOrder.forEach(a=>{if(areas[a])ordered[a]=areas[a];});
  Object.keys(areas).forEach(a=>{if(!ordered[a])ordered[a]=areas[a];});
  return ordered;
}

// Helper: compute month-over-month change for a project
function computeMonthlyChange(pjId, latestDate){
  const allKeys=Object.keys(appData.measurements||{}).filter(k=>k.startsWith(pjId+'_')).sort();
  const latestKey=pjId+'_'+latestDate;
  const idx=allKeys.indexOf(latestKey);
  const prevKey=idx>0?allKeys[idx-1]:null;
  const latestRecs=appData.measurements[latestKey]||[];
  const prevRecs=prevKey?appData.measurements[prevKey]:null;
  const prevDate=prevKey?prevKey.replace(pjId+'_',''):null;
  const daysBetween=prevDate?Math.max(1,Math.round((new Date(latestDate)-new Date(prevDate))/86400000)):30;

  const result={};
  latestRecs.forEach(r=>{
    const prev=prevRecs?prevRecs.find(x=>x.point===r.point):null;
    const monthlyDisp=prev&&r.cumDisp!=null&&prev.cumDisp!=null?parseFloat((r.cumDisp-prev.cumDisp).toFixed(2)):(r.disp!=null?parseFloat(r.disp.toFixed(2)):null);
    const monthlySettle=prev&&r.cumSettle!=null&&prev.cumSettle!=null?parseFloat((r.cumSettle-prev.cumSettle).toFixed(2)):(r.settle!=null?parseFloat(r.settle.toFixed(2)):null);
    const rateDisp=monthlyDisp!=null?parseFloat((monthlyDisp/daysBetween).toFixed(2)):null;
    const rateSettle=monthlySettle!=null?parseFloat((monthlySettle/daysBetween).toFixed(2)):null;
    result[r.point]={monthlyDisp,monthlySettle,rateDisp,rateSettle,daysBetween};
  });
  return result;
}

// Trend chart generator using hidden Canvas + Chart.js
async function generateTrendChart(pjId,projName,width,height){
  const {allDates,pointValuesMap}=buildTrendData(pjId);
  if(allDates.length<2||Object.keys(pointValuesMap).length===0)return null;

  const pointList=Object.keys(pointValuesMap).sort();
  const displayPoints=pointList.slice(0,28);
  const datasets=displayPoints.map((point,idx)=>{
    const color=COLORS28[idx%COLORS28.length];
    const data=allDates.map(date=>pointValuesMap[point][date]??null);
    return {label:point,data,borderColor:color,backgroundColor:color,borderWidth:1.5,pointRadius:0,pointHoverRadius:4,tension:0,fill:false,spanGaps:false};
  });

  const container=document.createElement('div');
  container.style.cssText='position:fixed;left:-9999px;top:-9999px;width:'+width+'px;height:'+height+'px;z-index:-1';
  const canvas=document.createElement('canvas');
  canvas.width=width;canvas.height=height;
  container.appendChild(canvas);
  document.body.appendChild(container);

  return new Promise((resolve)=>{
    const chart=new Chart(canvas.getContext('2d'),{
      type:'line',data:{labels:allDates,datasets},
      options:{responsive:false,animation:false,devicePixelRatio:2,
        plugins:{title:{display:true,text:projName+' 位移趋势图',font:{size:14},padding:10},legend:{position:'top',labels:{boxWidth:10,font:{size:8},padding:3}}},
        scales:{x:{title:{display:true,text:'日期',font:{size:10}},grid:{display:true,color:'rgba(0,0,0,0.06)'},ticks:{font:{size:8},maxRotation:45,maxTicksLimit:20}},
          y:{title:{display:true,text:'累计位移量(mm)',font:{size:10}},grid:{color:'rgba(0,0,0,0.06)'}}}
      }
    });
    setTimeout(()=>{
      try{const b64=canvas.toDataURL('image/png');chart.destroy();container.remove();resolve(b64);}
      catch(e){container.remove();resolve(null);}
    },200);
  });
}

function generateReport(){
  const checkboxes=document.querySelectorAll('#reportProjects input[type="checkbox"]:checked');
  const selectedIds=Array.from(checkboxes).map(cb=>cb.value);
  if(selectedIds.length===0){toast('请至少选择一个子项目','error');return;}

  const type=$('reportType').value,date=$('reportDate').value;
  if(!type){toast('请选择报告类型','error');return;}
  const reportDate=date||formatDate(new Date());
  const reportDateObj=new Date(reportDate);
  const year=reportDateObj.getFullYear(),month=reportDateObj.getMonth()+1;
  const chineseNums=['零','一','二','三','四','五','六','七','八','九','十','十一','十二'];
  const yearChinese=String(year).split('').map(c=>chineseNums[parseInt(c)]).join('');
  const monthChinese=chineseNums[month];
  const reportTypeLabel=type==='weekly'?'周报':'月报';
  const th=appData.thresholds||DEFAULT_THRESHOLDS;
  const areas=getReportDataByArea(selectedIds);
  const totalProjects=Object.values(areas).reduce((s,a)=>s+a.projects.length,0);
  const totalRecords=Object.values(areas).reduce((s,a)=>s+a.projects.reduce((ss,p)=>ss+p.dataKeys.length,0),0);

  if(totalProjects===0||totalRecords===0){toast('所选子项目暂无监测数据，请先导入数据','error');return;}

  toast('正在收集数据并预生成趋势图表...','info');
  addOperationLog('报告生成','多子项目合并'+reportTypeLabel+' → 共'+totalProjects+'个子项目,'+totalRecords+'条记录');

  // Count total periods per project
  function getPeriodCount(pjId){
    const allDates=new Set();
    ['measurements','anchorStress','blastVibration','convergence','waterLevel','inclinometerData'].forEach(store=>{
      Object.keys(appData[store]||{}).filter(k=>k.startsWith(pjId+'_')).forEach(k=>allDates.add(k.replace(pjId+'_','')));
    });
    // count incData dates (stored differently)
    var inc=appData.incData&&appData.incData[pjId];if(inc&&inc.length>0){inc.forEach(function(d){Object.keys(d.dates).forEach(function(dt){allDates.add(dt);});});}
    var conv=appData.convData&&appData.convData[pjId];if(conv&&conv.length>0){conv.forEach(function(cp){(cp.records||[]).forEach(function(r){allDates.add(r.date);});});}
    return allDates.size;
  }

  // ============ ASYNC BUILD ============
  (async function buildDoc(){
    const chartCache={};
    const areaOrder=['矿山加工系统','矿山','物流廊道','陆域堆场','码头平台'];
    // Pre-generate charts
    const chartPromises=[];
    areaOrder.forEach(ak=>{if(areas[ak])areas[ak].projects.forEach(proj=>{
      const {allDates}=buildTrendData(proj.id);
      if(allDates.length>=2)chartPromises.push(generateTrendChart(proj.id,proj.name,800,400).then(b64=>{chartCache[proj.id]=b64;}));
    });});
    await Promise.all(chartPromises);

    try{
      const {Document,Packer,Paragraph,TextRun,HeadingLevel,AlignmentType,Header,Footer,PageNumber,PageBreak,SectionType,BorderStyle,WidthType,Table,TableRow,TableCell,ImageRun}=docx;

      // Page footer only (no header, matching template)
      const pageFooter=new Footer({children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({children:[PageNumber.CURRENT],size:18,font:'宋体'})]})]});

      const docChildren=[];

      // ============ COVER PAGE (aligned to 第57期 template) ============
      // Top spacing
      docChildren.push(new Paragraph({spacing:{before:1800},children:[]}));
      // Project name line 1
      docChildren.push(new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:60},children:[new TextRun({text:'长九（神山）灰岩矿项目',size:36,bold:true,font:'宋体'})]}));
      // Subtitle
      docChildren.push(new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:60},children:[new TextRun({text:'安全监测工程',size:32,bold:true,font:'宋体'})]}));
      // Contract number
      docChildren.push(new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:400},children:[new TextRun({text:'（合同编号：CJ2023/01）',size:20,font:'宋体',color:'666666'})]}));
      // Main title with character spacing
      docChildren.push(new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:400},children:[new TextRun({text:'监  测  '+(type==='weekly'?'周':'月')+'  报',size:52,bold:true,font:'宋体'})]}));
      // Period
      docChildren.push(new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:1200},children:[new TextRun({text:year+'年'+month+'月（总第73期）',size:30,bold:true,font:'宋体'})]}));
      // Reviewers
      docChildren.push(new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:80},children:[new TextRun({text:'审  查：________',size:24,font:'宋体'})]}));
      docChildren.push(new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:80},children:[new TextRun({text:'校  核：________',size:24,font:'宋体'})]}));
      docChildren.push(new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:800},children:[new TextRun({text:'编  写：________',size:24,font:'宋体'})]}));
      // Organization
      docChildren.push(new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:80},children:[new TextRun({text:'中电建安徽长九新材料股份有限公司测量中心',size:22,font:'宋体',bold:true})]}));
      // Date in Chinese
      docChildren.push(new Paragraph({alignment:AlignmentType.CENTER,spacing:{before:200},children:[new TextRun({text:'二\u3007'+yearChinese.substring(2)+'年'+monthChinese+'月',size:22,font:'宋体'})]}));
      docChildren.push(new Paragraph({children:[new PageBreak()]}));

      // ============ TABLE OF CONTENTS ============
      docChildren.push(new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:400},children:[new TextRun({text:'目  录',size:30,bold:true,font:'宋体'})]}));
      const tocItems=[
        '1  概述',
        '2  矿山监测成果分析',
        '3  物流廊道监测成果分析',
        '4  陆域堆场监测成果分析',
        '5  码头平台沉降监测成果分析',
        '6  存在的主要问题与建议',
        '7  下月工作计划'
      ];
      tocItems.forEach(item=>{
        docChildren.push(new Paragraph({spacing:{after:100},children:[new TextRun({text:item,size:24,bold:true,font:'宋体'})]}));
      });
      docChildren.push(new Paragraph({children:[new PageBreak()]}));

      // ============ CHAPTER 1: 概述 ============
      docChildren.push(new Paragraph({spacing:{after:200},children:[new TextRun({text:'1  概述',size:30,bold:true,font:'宋体'})]}));

      // 1.1 监测工作概况
      docChildren.push(new Paragraph({spacing:{before:200,after:120},children:[new TextRun({text:'1.1  监测工作概况',size:26,bold:true,font:'宋体'})]}));
      docChildren.push(new Paragraph({indent:{firstLine:480},spacing:{after:120,line:360},children:[new TextRun({text:'目前，长九（神山）灰岩矿项目安全监测工作内容为现场观测、资料整编、巡视检查、设备维护、监测成果初步分析及后续监测项目仪器安装埋设及观测。主要包括：变形监测网的观测、复测；破碎硐室及运输平硐收敛观测、二期仓内钢立柱监测、物流廊道钢立柱监测、G5排架钢立柱、拉紧装置、廊道排架、金磊长胶与物流廊道搭接处结构及边坡监测；陆域堆场试验区、推广区、成品料各项安全监测；码头平台沉降观测。',size:22,font:'宋体'})]}));

      // 1.2 本月主要工作
      docChildren.push(new Paragraph({spacing:{before:200,after:120},children:[new TextRun({text:'1.2  本月主要工作',size:26,bold:true,font:'宋体'})]}));
      const workItems=[];
      areaOrder.forEach(ak=>{
        if(areas[ak]){
          const names=areas[ak].projects.map(p=>p.name);
          if(ak==='矿山加工系统'||ak==='矿山')workItems.push('对矿山破碎硐室收敛、二期网架及仓内钢立柱进行周期性安全监测');
          if(ak==='物流廊道')workItems.push('对物流廊道钢立柱、拉紧装置及廊道排架进行周期性安全监测');
          if(ak==='陆域堆场')workItems.push('对陆域堆场成品料、试验区及推广区进行周期性安全监测');
          if(ak==='码头平台')workItems.push('对码头平台进行周期性沉降监测');
        }
      });
      workItems.push('对矿山、物流廊道、陆域堆场、码头平台进行巡视检查');
      workItems.forEach((item,i)=>{
        docChildren.push(new Paragraph({indent:{firstLine:480},spacing:{after:60},children:[new TextRun({text:'（'+(i+1)+'）'+item,size:22,font:'宋体'})]}));
      });

      // 1.3 工作完成情况统计表
      docChildren.push(new Paragraph({spacing:{before:300,after:150},children:[new TextRun({text:'表1-1  本月工作完成情况统计',size:20,font:'宋体',bold:true})]}));

      // Build stat table
      const statHeaders=['序号','监测项目','监测内容','单位','仪器数量','观测频次','本月观测次数','备注'];
      const statRows=[];
      let seq=1;
      areaOrder.forEach(ak=>{
        if(!areas[ak])return;
        const projs=areas[ak].projects;
        const periodStr=projs.map(p=>getPeriodCount(p.id)).join('/');
        statRows.push([String(seq++),ak+'区域监测','变形/沉降/应力等','点',String(projs.reduce((s,p)=>s+(appData.measurements[p.id+'_'+(p.latestDate||'')]||[]).length,0)),'按频次','-','包含'+projs.length+'个子项目']);
      });

      // Stat table using direct docx API for better alignment with template
      const {TableCell:TC,Paragraph:P,TextRun:TR,AlignmentType:AT,BorderStyle:BS,WidthType:WT}=docx;
      const border={top:{style:BS.SINGLE,size:1,color:'000000'},bottom:{style:BS.SINGLE,size:1,color:'000000'},left:{style:BS.SINGLE,size:1,color:'000000'},right:{style:BS.SINGLE,size:1,color:'000000'}};
      const colWidths=[500,1500,1800,500,800,1000,1000,1200];
      const hcellsStat=statHeaders.map((h,i)=>new TC({borders:border,width:{size:colWidths[i]||1000,type:WT.DXA},verticalAlign:'center',
        children:[new P({alignment:AT.CENTER,spacing:{before:20,after:20},children:[new TR({text:h,bold:true,size:16,font:'宋体'})]})]}));
      const statAllRows=[new TableRow({children:hcellsStat,tableHeader:true})];
      statRows.forEach(row=>{
        const cells=row.map((c,i)=>new TC({borders:border,width:{size:colWidths[i]||1000,type:WT.DXA},verticalAlign:'center',
          children:[new P({alignment:AT.CENTER,spacing:{before:20,after:20},children:[new TR({text:String(c),size:16,font:'宋体'})]})]}));
        statAllRows.push(new TableRow({children:cells}));
      });
      docChildren.push(new Table({rows:statAllRows,width:{size:100,type:WT.PERCENTAGE}}));

      // Overview text
      docChildren.push(new Paragraph({spacing:{before:200,after:120},indent:{firstLine:480},children:[new TextRun({text:'本期报告涵盖'+totalProjects+'个监测子项目，累计'+totalRecords+'条监测记录。各监测项目数据来源于现场全站仪、水准仪、测斜仪、爆破测振仪等设备，经数据整编和分析后汇入本报告。',size:22,font:'宋体'})]}));
      docChildren.push(new Paragraph({children:[new PageBreak()]}));

      // ============ CHAPTERS 2-5: 各区域监测成果分析 ============
      const chapterConfig={
        '矿山加工系统':{chNum:2,title:'矿山监测成果分析',hasDirectionNote:true},
        '矿山':{chNum:2,title:'矿山监测成果分析',hasDirectionNote:true},
        '物流廊道':{chNum:3,title:'物流廊道监测成果分析',hasDirectionNote:false},
        '陆域堆场':{chNum:4,title:'陆域堆场监测成果分析',hasDirectionNote:false},
        '码头平台':{chNum:5,title:'码头平台沉降监测成果分析',hasDirectionNote:false}
      };
      let currentChNum=2;
      // Track chapter-level sub-section counters
      let chSubCounters={2:0,3:0,4:0,5:0};

      areaOrder.forEach(ao=>{
        if(!areas[ao]||areas[ao].projects.length===0)return;
        const cfg=chapterConfig[ao];
        if(!cfg)return;

        // Chapter title
        docChildren.push(new Paragraph({spacing:{before:100,after:200},children:[new TextRun({text:cfg.chNum+'  '+cfg.title,size:30,bold:true,font:'宋体'})]}));

        // Direction sign convention note
        if(cfg.hasDirectionNote){
          docChildren.push(new Paragraph({indent:{firstLine:480},spacing:{after:200,line:360},children:[new TextRun({text:'位移方向："+"为矿南路方向，"-"为矿北路方向。沉降方向："-"为隆起，"+"为下沉。根据《钢结构工程施工质量验收规范》中多节柱安装允许偏差中表示，多节柱允许偏移范围为H/1000，且不大于10.0mm，柱全高应小于35.0mm。',size:22,font:'宋体'})]}));
        }

        // Determine the chapter sub-section number for this area
        chSubCounters[cfg.chNum]++;

        // Each project = a sub-subsection (like 2.1, 2.2, etc.)
        let subIdx=0;
        areas[ao].projects.forEach(proj=>{
          subIdx++;
          const sectionNum=cfg.chNum+'.'+subIdx;
          const subTitle=sectionNum+'  '+proj.name;
          docChildren.push(new Paragraph({spacing:{before:200,after:120},children:[new TextRun({text:subTitle,size:26,bold:true,font:'宋体'})]}));

          const latestKey=proj.id+'_'+proj.latestDate;
          const records=appData.measurements[latestKey]||[];
          const anchorRecords=appData.anchorStress[latestKey]||[];
          const blastRecords=appData.blastVibration[latestKey]||[];
          const convergenceRecords=appData.convergence[latestKey]||[];
          const inclinoRecords=appData.inclinometerData[latestKey]||[];

          if(records.length>0){
            // Analysis paragraph with bold formatting for key numbers
            const analysisRuns=buildAnalysisText(records,proj.name,proj.latestDate,th);
            docChildren.push(buildAnalysisParagraph(analysisRuns));

            // Compute monthly changes
            const monthlyMap=computeMonthlyChange(proj.id,proj.latestDate);

            // Build table matching template format: 测点编号 | 取基准值日期 | 累计变化量 | 本月变化量 | 变化速率 | 累计沉降量 | 本月沉降量 | 沉降速率 | 备注
            const tableHeaders=['测点编号','取基准值\n日期','累计变化量\n(mm)','本月变化量\n(mm)','变化速率\n(mm/d)','累计沉降量\n(mm)','本月沉降量\n(mm)','沉降速率\n(mm/d)','备注'];

            const tblColWidths=[850,1000,900,900,850,900,900,850,650];
            const hcells=tblColWidths.map((w,i)=>new TC({borders:border,width:{size:w,type:WT.DXA},verticalAlign:'center',
              children:[new P({alignment:AT.CENTER,spacing:{before:20,after:20},children:[new TR({text:tableHeaders[i].replace(/\\n/g,''),bold:true,size:16,font:'宋体'})]})]}));
            const allRows=[new TableRow({children:hcells,tableHeader:true})];

            // Only skip the first row if it's a header placeholder (point name = "监测点号")
            const tableRecords=records.slice(0,80).filter((r,i)=>{
              if(i===0 && r.point==='监测点号') return false;
              return true;
            });

            // Pre-compute all numeric values per column for abs-max detection
            const numCols=[2,3,4,5,6,7]; // indices in cellDefs
            const colAccessors=[
              (r,mm)=>r.cumDisp,
              (r,mm)=>mm.monthlyDisp,
              (r,mm)=>mm.rateDisp,
              (r,mm)=>r.cumSettle,
              (r,mm)=>mm.monthlySettle,
              (r,mm)=>mm.rateSettle
            ];
            const colMaxAbs=numCols.map(()=>0);
            const colPrelim = tableRecords.map(r=>{
              const mm=monthlyMap[r.point]||{};
              return colAccessors.map(fn=>fn(r,mm));
            });
            colPrelim.forEach(vals=>{
              vals.forEach((v,j)=>{
                if(v!=null&&Math.abs(v)>colMaxAbs[j])colMaxAbs[j]=Math.abs(v);
              });
            });

            // Build data rows
            tableRecords.forEach(r=>{
              const mm=monthlyMap[r.point]||{};
              const cumDisp=r.cumDisp!=null?r.cumDisp:null;
              const cumSettle=r.cumSettle!=null?r.cumSettle:null;
              const mDisp=mm.monthlyDisp;
              const mSettle=mm.monthlySettle;
              const rDisp=mm.rateDisp;
              const rSettle=mm.rateSettle;

              const vals=[cumDisp,mDisp,rDisp,cumSettle,mSettle,rSettle];
              const isRed=vals.map((v,i)=>v!=null&&Math.abs(v)===colMaxAbs[i]);

              const cellDefs=[
                {t:r.point},
                {t:proj.latestDate},
                {t:cumDisp!=null?cumDisp.toFixed(2):'-',color:isRed[0]?'FF0000':undefined},
                {t:mDisp!=null?mDisp.toFixed(2):'-',color:isRed[1]?'FF0000':undefined},
                {t:rDisp!=null?rDisp.toFixed(2):'-',color:isRed[2]?'FF0000':undefined},
                {t:cumSettle!=null?cumSettle.toFixed(2):'-',color:isRed[3]?'FF0000':undefined},
                {t:mSettle!=null?mSettle.toFixed(2):'-',color:isRed[4]?'FF0000':undefined},
                {t:rSettle!=null?rSettle.toFixed(2):'-',color:isRed[5]?'FF0000':undefined},
                {t:''}
              ];

              const cells=cellDefs.map((cd,i)=>new TC({borders:border,width:{size:tblColWidths[i],type:WT.DXA},verticalAlign:'center',
                children:[new P({alignment:AT.CENTER,spacing:{before:20,after:20},children:[new TR({text:cd.t,size:16,font:'宋体',color:cd.color||undefined})]})]}));
              allRows.push(new TableRow({children:cells}));
            });

            // Table title
            const tableTitle='表'+sectionNum+'-1  '+proj.name+'监测成果表（共'+tableRecords.length+'个测点）';
            docChildren.push(new Paragraph({spacing:{before:200,after:100},children:[new TextRun({text:tableTitle,size:20,font:'宋体',bold:true})]}));
            docChildren.push(new Table({rows:allRows,width:{size:100,type:WT.PERCENTAGE}}));

            if(records.length>80){
              docChildren.push(new Paragraph({alignment:AT.CENTER,spacing:{before:60},children:[new TextRun({text:'...共'+records.length+'条记录，仅展示前80条',size:18,font:'宋体',color:'999999'})]}));
            }

            // Embed trend chart
            if(chartCache[proj.id]){
              const figTitle='图'+sectionNum+'-1  '+proj.name+'累计位移变化趋势图';
              docChildren.push(new Paragraph({spacing:{before:300,after:100},children:[new TextRun({text:figTitle,size:20,font:'宋体',bold:true})]}));
              try{
                const rawBase64=chartCache[proj.id].replace(/^data:image\/\w+;base64,/,'');
                docChildren.push(new Paragraph({alignment:AT.CENTER,children:[new ImageRun({data:rawBase64,transformation:{width:520,height:260},type:'png'})]}));
              }catch(imgErr){
                docChildren.push(new Paragraph({alignment:AT.CENTER,children:[new TextRun({text:'[图表生成失败]',size:18,font:'宋体',color:'999999'})]}));
              }
            }
          }else{
            // Handle non-displacement data types
            let descText='本期暂无监测数据。';
            if(anchorRecords.length>0){
              const maxStress=Math.max(...anchorRecords.map(r=>Math.abs(r.stress||0)));
              descText='截至'+proj.latestDate+'，锚杆应力监测数据正常，最大应力值为'+maxStress.toFixed(2)+'MPa。';
            }else if(blastRecords.length>0){
              descText='爆破振动监测数据已采集，各测点振动速度未超警戒值，处于稳定状态。';
            }else if(convergenceRecords.length>0){
              const maxConv=Math.max(...convergenceRecords.map(r=>Math.abs(r.cumDisp||r.length||0)));
              descText='收敛监测数据已采集，最大收敛值'+maxConv.toFixed(2)+'mm，未超警戒值。';
            }else if(appData.convData&&appData.convData[proj.id]&&appData.convData[proj.id].length>0){
              // 详细收敛报告（来自convData）
              var convList=appData.convData[proj.id];
              var allCvDates=[];convList.forEach(function(cp){(cp.records||[]).forEach(function(r){if(allCvDates.indexOf(r.date)<0)allCvDates.push(r.date);});});allCvDates.sort();
              var cvSummary=[];convList.forEach(function(cp){
                var recs=cp.records||[];if(recs.length===0)return;recs.sort(function(a,b){return a.date.localeCompare(b.date);});
                var firstDist=recs[0].distance,lastDist=recs[recs.length-1].distance;
                var cumChange=parseFloat((lastDist-firstDist).toFixed(2)),monthlyChange=null,monthlyRate=null;
                if(recs.length>=2){var pr=recs[recs.length-2];monthlyChange=parseFloat((lastDist-pr.distance).toFixed(2));var days=Math.max(1,Math.round((new Date(recs[recs.length-1].date)-new Date(pr.date))/86400000));monthlyRate=parseFloat((monthlyChange/days).toFixed(2));}
                cvSummary.push({pointPair:cp.pointPair,cumChange:cumChange,monthlyChange:monthlyChange,monthlyRate:monthlyRate,firstDist:firstDist,lastDist:lastDist,records:recs});
              });
              var cvMaxCum=0,cvMaxRate=0;cvSummary.forEach(function(s){if(Math.abs(s.cumChange)>cvMaxCum)cvMaxCum=Math.abs(s.cumChange);if(Math.abs(s.monthlyRate||0)>cvMaxRate)cvMaxRate=Math.abs(s.monthlyRate||0);});
              var cvMaxPair=cvSummary.reduce(function(a,b){return Math.abs(a.cumChange)>=Math.abs(b.cumChange)?a:b;});
              var cvMaxRPair=cvSummary.reduce(function(a,b){return Math.abs(a.monthlyRate||0)>=Math.abs(b.monthlyRate||0)?a:b;});
              // Text paragraph
              docChildren.push(new Paragraph({indent:{firstLine:480},spacing:{after:120,line:360},children:[new TextRun({text:'监测时段：'+allCvDates[0]+' 至 '+allCvDates[allCvDates.length-1]+'，共 '+cvSummary.length+' 个测点对，'+allCvDates.length+' 期数据。最大累计变化为 '+cvMaxPair.pointPair+'（累计 '+cvMaxPair.cumChange+' mm），最大速率为 '+cvMaxRPair.pointPair+'（'+cvMaxRPair.monthlyRate+' mm/d）。',size:22,font:'宋体'})]}));
              // Table 1: multi-period comparison
              docChildren.push(new Paragraph({spacing:{before:200,after:80},children:[new TextRun({text:'表'+sectionNum+'-1  收敛变形监测成果（多期对比）',size:20,font:'宋体',bold:true})]}));
              var t1Headers=['测点对'].concat(allCvDates);
              var t1Rows=cvSummary.map(function(s){var dm={};s.records.forEach(function(r){dm[r.date]=r.distance;});var row=[s.pointPair];allCvDates.forEach(function(d){row.push(dm[d]!=null?dm[d].toFixed(2):'-');});return row;});
              docChildren.push(buildDataTable(t1Headers,t1Rows,{colWidth:1200}));
              // Table 2: summary
              docChildren.push(new Paragraph({spacing:{before:200,after:80},children:[new TextRun({text:'表'+sectionNum+'-2  收敛点变形监测成果（测点汇总）',size:20,font:'宋体',bold:true})]}));
              var t2Rows=cvSummary.map(function(s){
                var cRed=Math.abs(s.cumChange)===cvMaxCum&&cvMaxCum>0,rRed=Math.abs(s.monthlyRate||0)===cvMaxRate&&cvMaxRate>0;
                return [s.pointPair,(s.monthlyChange!=null?s.monthlyChange.toFixed(2):'-'),s.cumChange.toFixed(2),(s.monthlyRate!=null?s.monthlyRate.toFixed(2):'-')];
              });
              var cvTable2=buildCVSummaryTable(['点号','本月变化量(mm)','累计位移(mm)','本月变化速率(mm/d)'],t2Rows,cvSummary,cvMaxCum,cvMaxRate);
              docChildren.push(cvTable2);
              descText=''; // skip default desc
            }else if(inclinoRecords.length>0){
              const holes=[...new Set(inclinoRecords.map(r=>r.hole))];
              const maxDisp=Math.max(...inclinoRecords.map(r=>Math.abs(r.cumDisp||0)));
              descText='测斜孔共'+holes.length+'个，最大累积位移'+maxDisp.toFixed(2)+'mm。';
            }
            docChildren.push(new Paragraph({indent:{firstLine:480},spacing:{after:120},children:[new TextRun({text:descText,size:22,font:'宋体'})]}));
          }
        });

        currentChNum=cfg.chNum;
        docChildren.push(new Paragraph({children:[new PageBreak()]}));
      });

      // ============ CHAPTER 6: 存在的主要问题与建议 ============
      docChildren.push(new Paragraph({spacing:{before:200,after:200},children:[new TextRun({text:'6  存在的主要问题与建议',size:30,bold:true,font:'宋体'})]}));

      // Collect all alerts
      const allAlerts=[];
      Object.values(areas).forEach(a=>{a.projects.forEach(p=>{
        const keys=Object.keys(appData.measurements||{}).filter(k=>k.startsWith(p.id+'_')).sort();
        if(keys.length>0){
          const recs=appData.measurements[keys[keys.length-1]]||[];
          recs.forEach(r=>{
            if(Math.abs(r.cumDisp||0)>=(th.cum_orange||50))allAlerts.push({point:r.point,proj:p.name,val:r.cumDisp,type:'位移'});
            if(Math.abs(r.cumSettle||0)>=(th.settle_orange||30))allAlerts.push({point:r.point,proj:p.name,val:r.cumSettle,type:'沉降'});
          });
        }
      });});

      if(allAlerts.length>0){
        docChildren.push(new Paragraph({indent:{firstLine:480},spacing:{after:120},children:[new TextRun({text:'本期监测发现以下预警情况需重点关注：',size:22,font:'宋体',bold:true})]}));
        allAlerts.slice(0,15).forEach(a=>{
          docChildren.push(new Paragraph({indent:{firstLine:480},spacing:{after:60},children:[new TextRun({text:a.proj+' '+a.point+'号测点：'+a.type+'累计'+a.val.toFixed(2)+'mm，超过预警值，建议加强监测频率并分析原因。',size:22,font:'宋体'})]}));
        });
      }else{
        docChildren.push(new Paragraph({indent:{firstLine:480},spacing:{after:120},children:[new TextRun({text:'本期各监测项目数据均在正常范围内，未发现异常预警情况。',size:22,font:'宋体'})]}));
      }

      docChildren.push(new Paragraph({indent:{firstLine:480},spacing:{after:120,line:360},children:[new TextRun({text:'建议共同维护监测设施及监测基准点，加强现场协调保护位于堆场仓内的监测设施，以免因孔位被破坏导致永久无法使用。部分监测点位因扬尘影响面临监测误差较大的情况且监测点位脱落，建议试点自动化监测以提升精度和效率。',size:22,font:'宋体'})]}));
      docChildren.push(new Paragraph({children:[new PageBreak()]}));

      // ============ CHAPTER 7: 下月工作计划 ============
      docChildren.push(new Paragraph({spacing:{after:200},children:[new TextRun({text:'7  下月工作计划',size:30,bold:true,font:'宋体'})]}));
      const planItems=[];
      planItems.push('对矿山破碎硐室收敛、仓内钢立柱及网架基础进行周期性安全监测');
      planItems.push('对物流廊道钢立柱、拉紧装置及廊道排架进行周期性安全监测');
      planItems.push('对陆域堆场成品料、试验区及推广区进行周期性安全监测');
      planItems.push('对码头平台进行周期性沉降监测');
      planItems.push('对矿山、物流廊道、陆域堆场、码头平台等重点部位进行巡视检查');
      planItems.push('进行监测数据整编分析，编制监测月报');
      planItems.forEach((item,i)=>{
        docChildren.push(new Paragraph({indent:{firstLine:480},spacing:{after:80},children:[new TextRun({text:'（'+(i+1)+'）'+item,size:22,font:'宋体'})]}));
      });

      // ============ BUILD DOCUMENT ============
      const sectionProps={page:{margin:{top:1440,bottom:1440,left:1440,right:1440},size:{width:11906,height:16838}}};
      const doc=new Document({sections:[{properties:sectionProps,footers:{default:pageFooter},children:docChildren}]});

      Packer.toBlob(doc).then(blob=>{
        const url=URL.createObjectURL(blob);
        const a=document.createElement('a');
        a.href=url;
        a.download='长九（神山）灰岩矿项目安全监测'+reportTypeLabel+'_'+year+'年'+month+'月（总第73期）.docx';
        a.click();
        URL.revokeObjectURL(url);
        toast(reportTypeLabel+'已生成！格式对齐第57期模板，共'+totalProjects+'个子项目、7章完整结构','success');
      });
    }catch(e){
      console.error(e);
      toast('报告生成失败: '+e.message,'error');
    }
  })();
}
// ==================== SHARE SELECT ====================
function populateShareSelect(){const container=$('shareProjects');container.innerHTML=(appData.projects||[]).map(p=>'<label><input type="checkbox" value="'+p.id+'">['+p.group+'] '+p.name+'</label>').join('');}

// ==================== EXPORT / RESTORE ====================
function exportAllData(){const json=JSON.stringify(appData,null,2);const blob=new Blob([json],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='monitor_backup_'+formatDate(new Date())+'.json';a.click();URL.revokeObjectURL(url);toast('数据已导出','success');addOperationLog('备份','导出全部数据');}
function handleRestoreFile(){
  const file=$('restoreFile').files[0];if(!file)return;if(!confirm('恢复数据将覆盖当前所有数据，确定继续？建议先导出备份。'))return;
  const reader=new FileReader();
  reader.onload=function(e){try{const data=JSON.parse(e.target.result);appData=data;const defaults=['anchorStress','blastVibration','convergence','waterLevel','staticLevel','tunnelSettlement','baselineTypes'];defaults.forEach(k=>{if(!(k in appData))appData[k]={};});saveData(appData);renderOverview();populateAllSelects();toast('数据恢复成功','success');addOperationLog('备份','从文件恢复数据');}catch(err){toast('JSON解析失败: '+err.message,'error');}};reader.readAsText(file);
}
function showImportAllModal(){document.getElementById('restoreFile').click();}

// ==================== SELF TEST ====================
function runSelfTest(){
  const pjId='p06'; // 成品料网架-南侧
  const testDates=['2026-06-10','2026-06-17','2026-06-26'];
  const basePoints=[
    {point:'CN3',ix:3363874.3593,iy:528434.7494,iz:65.8586,cx:3363874.36147,cy:528434.74878,cz:65.85894},
    {point:'CN6',ix:3363900.6479,iy:528468.2338,iz:65.9606,cx:3363900.64999,cy:528468.23286,cz:65.96313},
    {point:'CN9',ix:3363981.5413,iy:528571.6850,iz:64.0998,cx:3363981.5408,cy:528571.68565,cz:64.10244},
    {point:'CN12',ix:3363918.8918,iy:528491.6005,iz:65.5907,cx:3363918.89366,cy:528491.5996,cz:65.5933},
    {point:'CN15',ix:3363933.1221,iy:528509.7954,iz:64.9860,cx:3363933.12308,cy:528509.79524,cz:64.98786},
    {point:'CN18',ix:3363960.2740,iy:528544.5135,iz:64.6206,cx:3363960.27416,cy:528544.51348,cz:64.62315},
    {point:'CN21',ix:3364008.5731,iy:528606.1984,iz:63.7687,cx:3364008.5722,cy:528606.1991,cz:63.7716},
    {point:'CN23',ix:3364030.1805,iy:528633.8530,iz:63.4190,cx:3364030.1780,cy:528633.8549,cz:63.4217},
    {point:'CN27',ix:3364053.3515,iy:528663.5654,iz:63.2875,cx:3364053.3479,cy:528663.5687,cz:63.2893},
    {point:'CN32',ix:3364067.7199,iy:528681.8916,iz:62.9569,cx:3364067.7149,cy:528681.8952,cz:62.9591},
    {point:'CN37',ix:3364083.9363,iy:528702.6429,iz:62.5130,cx:3364083.9309,cy:528702.6473,cz:62.5108},
    {point:'CN42',ix:3364100.1610,iy:528723.3218,iz:62.2561,cx:3364100.1583,cy:528723.3233,cz:62.2496},
    {point:'CN50',ix:3364116.2000,iy:528743.7793,iz:62.1203,cx:3364116.1954,cy:528743.7826,cz:62.1193},
    {point:'CN53',ix:3364132.5040,iy:528764.6613,iz:62.0419,cx:3364132.4985,cy:528764.6650,cz:62.0407}
  ];
  const bl=getBaselineForType(pjId,'displacement');
  if(!appData.measurements)appData.measurements={};
  testDates.forEach((date,dateIdx)=>{
    const key=pjId+'_'+date,records=[];
    basePoints.forEach(ep=>{
      const result=calcDisplacement(ep.ix,ep.iy,ep.iz,ep.cx,ep.cy,ep.cz,bl,bl.calcMode||'offset');
      let cumDisp=result.dDisp,cumSettle=result.settle;
      if(dateIdx>0){const prevRecords=appData.measurements[pjId+'_'+testDates[dateIdx-1]]||[];const pr=prevRecords.find(r=>r.point===ep.point);if(pr){cumDisp=parseFloat((pr.cumDisp+(result.dDisp-pr.disp)).toFixed(2));cumSettle=parseFloat((pr.cumSettle+(result.settle-pr.settle)).toFixed(2));}}
      records.push({point:ep.point,ix:ep.ix,iy:ep.iy,iz:ep.iz,cx:ep.cx,cy:ep.cy,cz:ep.cz,dInit:result.dInit,dCurr:result.dCurr,disp:result.dDisp,settle:result.settle,cumDisp,cumSettle,calcMode:bl.calcMode||'offset'});
    });
    appData.measurements[key]=records;
  });
  saveData(appData);
  const {allDates,pointValuesMap}=buildTrendData(pjId),datasets=buildTrendDatasets(allDates,pointValuesMap);
  $('trendProject').value=pjId;renderTrendChart();switchPanel('process');
  addOperationLog('自检测试','生成3期x14测点模拟数据 ('+(bl.calcMode||'offset')+'模式)');
  toast('自检完成！14测点x3期数据，计算模式: '+(bl.calcMode||'偏移'),'success');
}

function loadRealDataTest(){runSelfTest();toast('真实坐标测试数据已加载','info');}

window.runSelfTest=runSelfTest;window.loadRealDataTest=loadRealDataTest;
// Expose cloud auth + report functions for HTML onclick handlers (needed because try block limits scope)
window.showCloudAuthModal=showCloudAuthModal;
window.cloudSignUpFromModal=cloudSignUpFromModal;
window.cloudSignInFromModal=cloudSignInFromModal;
window.syncLocalUserFromCloud=syncLocalUserFromCloud;
window.cloudSignUp=cloudSignUp;
window.cloudSignIn=cloudSignIn;
window.doLogin=doLogin;
window.initApp=initApp;
window.logout=logoutUser;
window.selectAllReportProjects=selectAllReportProjects;
window.deselectAllReportProjects=deselectAllReportProjects;
window.onReportProjectChange=onReportProjectChange;
window.generateReport=generateReport;

// ==================== INIT ====================
function populateAllSelects(){populateBaselineSelect();populateImportSelect();populateProcessSelect();populateTrendSelect();populateHistorySelect();populateReportSelect();populateShareSelect();}
document.addEventListener('click',function(e){if(e.target.classList.contains('modal-overlay'))e.target.classList.remove('show');});

try {
initSupabase();
loadUser();
if(!currentUser){$('loginOverlay').style.display='flex';}else{$('loginOverlay').style.display='none';initApp();}
window.__APP_LOADED__ = true;
} catch(e) {
window.__APP_ERROR__ = e.message + ' | ' + (e.stack||'').substring(0,200);
console.error('APP INIT ERROR:', e);
}
} catch(e) {
window.__APP_ERROR__ = 'SCRIPT PARSE ERROR: ' + e.message;
console.error('APP SCRIPT ERROR:', e);
}