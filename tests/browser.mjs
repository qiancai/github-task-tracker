const { chromium } = await import(process.env.GTT_PLAYWRIGHT_MODULE || 'playwright');
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const extensionPath = fileURLToPath(new URL('../', import.meta.url));
const screenshots = join(extensionPath, 'test-results');
await mkdir(screenshots, { recursive: true });
const profile=await mkdtemp(join(tmpdir(),'gtt-integration-'));
const context=await chromium.launchPersistentContext(profile,{channel:'chromium',executablePath:process.env.GTT_CHROME_EXECUTABLE,headless:true,args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`],viewport:{width:1280,height:900}});
try {
const errors=[];
context.on('page',page=>page.on('pageerror',e=>errors.push(e.message)));
const fixture=`<!doctype html><html><head><title>PR fixture</title><style>body{font:14px system-ui;padding:60px;color:#1f2328}li,.Box-row{padding:20px;border:1px solid #d1d9e0;list-style:none;overflow:hidden}h3{margin:0;font-size:16px}a{color:inherit;text-decoration:none}</style></head><body><main id="repo-content-pjax-container"><h1>Pull requests</h1><ul><li id="modern-row"><div data-listview-item-title-container="true"><h3><a href="/pingcap/docs/pull/24528" data-testid="listitem-title-link">docs: improve configuration</a></h3></div></li></ul><div id="issue_24610" class="Box-row js-issue-row"><a href="/pingcap/docs/pull/24610">cdc: update rename DDL behavior</a><a href="/pingcap/docs/pull/24610#comments">5 comments</a></div><a href="/pingcap/docs/pull/99">Unrelated link outside the list</a></main></body></html>`;
const detailFixture=await readFile(join(extensionPath,'docs/fixtures/github-pull.html'),'utf8');
await context.route('https://github.com/**',route=>{
  const path=new URL(route.request().url()).pathname;
  return route.fulfill({contentType:'text/html',body:/\/(?:pull|issues)\/\d+\/?$/.test(path)?detailFixture:fixture});
});
const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
const base=worker.url().replace('/src/background.js','');
const settings=await context.newPage(); await settings.goto(base+'/settings.html'); await settings.waitForSelector('.label-row');
const getState=()=>settings.evaluate(async()=>{const result=await chrome.runtime.sendMessage({scope:'github-task-tracker',type:'get'});if(!result.ok)throw Error(result.error);return result.data;});
const page=await context.newPage(); await page.goto('https://github.com/pingcap/docs/pulls'); await page.waitForSelector('[data-gtt]');
assert.equal(await page.locator('[data-gtt]').count(),2);
// Settings must reject duplicate names without losing input or modifying persisted data.
const beforeRename=JSON.stringify(await getState());
const selfName=settings.getByRole('textbox',{name:'Name for Pending by me',exact:true});
await selfName.fill(' WAIT FOR REVIEW ');
await settings.locator('.label-row').nth(1).getByRole('button',{name:'Save',exact:true}).click();
await settings.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Choose a different name'));
assert.equal(JSON.stringify(await getState()),beforeRename);
assert.equal(await selfName.inputValue(),' WAIT FOR REVIEW ');
await selfName.fill('Pending by me');
const sessions=new Map();
async function shadow(page,selector,fn,key='pingcap/docs#24528'){
  let cdp=sessions.get(page); if(!cdp){cdp=await context.newCDPSession(page);sessions.set(page,cdp);}
  const {root}=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});
  const nodes=[]; const walk=n=>{nodes.push(n);for(const child of [...(n.children||[]),...(n.shadowRoots||[])])walk(child);};walk(root);
  const host=nodes.find(n=>n.attributes?.some((x,i,a)=>x==='data-gtt'&&a[i+1]===key));
  assert.ok(host,'Expected widget host');
  const {object}=await cdp.send('DOM.resolveNode',{nodeId:host.shadowRoots[0].nodeId});
  const result=await cdp.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:`function(){const target=this.querySelector(${JSON.stringify(selector)});return (${fn})(target,this);}`,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw Error(result.exceptionDetails.text+JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(predicate,message){for(let i=0;i<100;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,50));}throw Error(message);}
// Page shortcuts work from closed controls; editing keystrokes stay inside the picker.
await page.evaluate(() => {
  window.gttKeys = [];
  document.addEventListener('keydown', event => window.gttKeys.push(event.key));
});
await shadow(page, 'summary', 'n=>n.focus()');
await page.keyboard.press('j');
await page.keyboard.press('/');
assert.deepEqual(await page.evaluate(() => window.gttKeys), ['j', '/']);
await shadow(page, 'summary', 'n=>n.click()');
await until(()=>shadow(page,'.panel',`n=>n.matches(':popover-open')`),'Keyboard test editor did not open');
await shadow(page, '.create-toggle', 'n=>n.click()');
await page.keyboard.type('j/k');
assert.equal(await shadow(page, '.create-fields input[type=text]', 'n=>n.value'), 'j/k');
await page.keyboard.press('Escape');
assert.equal(await shadow(page, 'details', 'n=>n.open'), false);
assert.equal(await shadow(page, 'summary', '(n,root)=>root.activeElement===n'), true);
assert.deepEqual(await page.evaluate(() => window.gttKeys), ['j', '/']);
await page.keyboard.press('k');
assert.deepEqual(await page.evaluate(() => window.gttKeys), ['j', '/', 'k']);
// Reset the canceled creation form before continuing the existing editor scenarios.
await shadow(page, '.create-fields input[type=text]', 'n=>{n.value="";}');
await shadow(page, '.create-actions button[type=button]', 'n=>n.click()');
await shadow(page,'summary','n=>n.click()');
await until(()=>shadow(page,'.panel',`n=>n.matches(':popover-open')`),'Popover did not open');
await shadow(page,'input',`n=>n.click()`);
await until(async()=>(await getState()).pullRequests['pingcap/docs#24528']?.includes('wait-review'),'Checkbox did not save');
await shadow(page,'label:nth-child(2) input',`n=>n.click()`);
await until(async()=>(await getState()).pullRequests['pingcap/docs#24528']?.length===2,'Multiple labels did not save');
// Dragging a handle reorders labels globally without toggling any checkbox.
const assignmentsBeforeOrder=JSON.stringify((await getState()).pullRequests);
const dragStart=await shadow(page,'.choices [data-order-id="wait-review"] .label-order-handle','n=>{const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};}');
const dragEnd=await shadow(page,'.choices [data-order-id="ready-merge"]','n=>{const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.bottom-2};}');
await page.mouse.move(dragStart.x,dragStart.y); await page.mouse.down();
await page.mouse.move(dragEnd.x,dragEnd.y,{steps:12}); await page.mouse.up();
await until(async()=>(await getState()).labels.at(-1).id==='wait-review','Dragging label handle did not persist order');
assert.equal(JSON.stringify((await getState()).pullRequests),assignmentsBeforeOrder);
assert.equal(await shadow(page,'.choices label:first-child','n=>n.dataset.orderId'),'pending-self');
await shadow(page,'.choices [data-order-id="wait-review"] .label-order-handle',`n=>n.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',altKey:true,bubbles:true,cancelable:true}))`);
await until(async()=>(await getState()).labels[2].id==='wait-review','Keyboard label movement failed');
await settings.evaluate(async()=>{await chrome.runtime.sendMessage({scope:'github-task-tracker',type:'moveLabel',labelId:'wait-review',targetId:'pending-self',after:false});});
await until(()=>shadow(page,'.choices label:first-child',`n=>n.dataset.orderId==='wait-review'`),'Order was not synchronized back to open editor');
assert.equal(JSON.stringify((await getState()).pullRequests),assignmentsBeforeOrder);
await page.screenshot({path:join(screenshots, 'editor.png')});
// Create and apply a label without leaving the PR list, then reject a duplicate safely.
await shadow(page, '.create-toggle', 'n=>n.click()');
assert.equal(await shadow(page, '.create-form', 'n=>n.hidden'), false);
await shadow(page, '.create-fields input[type=text]', 'n=>{n.value="Pending by designer";}');
await shadow(page, '.create-fields input[type=color]', 'n=>{n.value="#facc15";}');
assert.ok(await shadow(page, '.create-fields input[type=color]', `(n,root)=>{const color=n.getBoundingClientRect();const panel=root.querySelector('.panel').getBoundingClientRect();return color.width>=30&&color.right<=panel.right-10;}`),'Inline color picker is clipped');
await page.screenshot({path:join(screenshots, 'inline-create.png')});
await shadow(page, '.create-submit', 'n=>n.click()');
await until(async()=>(await getState()).labels.some(label=>label.name==='Pending by designer'),'Inline creation failed');
const created=(await getState()).labels.find(label=>label.name==='Pending by designer');
assert.ok((await getState()).pullRequests['pingcap/docs#24528'].includes(created.id));
assert.equal(await shadow(page, '.create-form', 'n=>n.hidden'), true);
const filled=await shadow(page, '.selected-labels', `(n,root)=>{const label=[...n.querySelectorAll('.badge')].find(item=>item.querySelector('.label-name')?.textContent==='Pending by designer');return {background:getComputedStyle(label).backgroundColor,color:getComputedStyle(label).color,lock:!!label.querySelector('svg')};}`);
assert.deepEqual(filled,{background:'rgb(250, 204, 21)',color:'rgb(0, 0, 0)',lock:true});
const beforeDuplicate=JSON.stringify(await getState());
await shadow(page, '.create-toggle', 'n=>n.click()');
await shadow(page, '.create-fields input[type=text]', 'n=>{n.value="WAIT FOR REVIEW";}');
await shadow(page, '.create-submit', 'n=>n.click()');
await until(async()=>(await shadow(page, '.error', 'n=>n.textContent')).includes('already exists'),'Duplicate was not rejected');
assert.equal(JSON.stringify(await getState()),beforeDuplicate);
await shadow(page, '.create-actions button[type=button]', 'n=>n.click()');
assert.equal(await shadow(page, '.create-form', 'n=>n.hidden'), true);
assert.equal(JSON.stringify(await getState()),beforeDuplicate);
await page.screenshot({path:join(screenshots, 'filled-labels.png')});
const tab2=await context.newPage();await tab2.goto('https://github.com/pulls');await tab2.waitForSelector('[data-gtt]');
assert.ok((await shadow(tab2,'.selected-labels',`n=>n.textContent`)).includes('Pending by me'));
// The cross removes one assignment, keeps definitions, and handles storage failures.
async function clickShadow(page, selector, key='pingcap/docs#24528') {
  const rect=await shadow(page,selector,'n=>{const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};}',key);
  await page.mouse.click(rect.x,rect.y);
}
await shadow(page,'.footer button:last-child','n=>n.click()');
const definitionsBeforeRemoval=JSON.stringify((await getState()).labels);
await clickShadow(page,'.remove-label[data-label-id="wait-review"]');
await until(async()=>!(await getState()).pullRequests['pingcap/docs#24528'].includes('wait-review'),'Cross did not remove the current PR assignment');
assert.equal(JSON.stringify((await getState()).labels),definitionsBeforeRemoval);
assert.ok((await getState()).pullRequests['pingcap/docs#24528'].includes('pending-self'));
assert.ok((await getState()).pullRequests['pingcap/docs#24528'].includes(created.id));
await until(async()=>await shadow(tab2,'.remove-label[data-label-id="wait-review"]','n=>n===null'),'Cross removal did not synchronize');
assert.equal(await shadow(page,'details','n=>n.open'),false,'Cross opened the editor');
await clickShadow(page,'summary');
await until(()=>shadow(page,'.panel',`n=>n.matches(':popover-open')`),'Plus did not retain editing behavior');
await shadow(page,'.choices input','n=>n.click()');
await until(async()=>(await getState()).pullRequests['pingcap/docs#24528'].length===3,'Reapplying removed label failed');
const beforeFailedRemoval=JSON.stringify(await getState());
await worker.evaluate(()=>{
  globalThis.originalStorageSet=chrome.storage.local.set;
  chrome.storage.local.set=()=>Promise.reject(new Error('Simulated save failure'));
});
try {
  await clickShadow(page,'.remove-label[data-label-id="pending-self"]');
  await until(async()=>(await shadow(page,'.inline-error','n=>n.textContent')).includes('Simulated save failure'),'Failed removal was not reported');
  assert.equal(JSON.stringify(await getState()),beforeFailedRemoval);
  assert.equal(await shadow(page,'.remove-label[data-label-id="pending-self"]','n=>n.disabled'),false);
} finally {
  await worker.evaluate(()=>{chrome.storage.local.set=globalThis.originalStorageSet;delete globalThis.originalStorageSet;});
}
// Rename through settings and verify real worker broadcasts to both tabs.
await settings.getByRole('textbox',{name:'Name for Wait for review',exact:true}).fill('Waiting for PM');
await settings.locator('.label-row').first().getByRole('button',{name:'Save',exact:true}).click();
await until(async()=>(await shadow(page,'.selected-labels',`n=>n.textContent`)).includes('Waiting for PM'),'Rename not broadcast');
await until(async()=>(await shadow(tab2,'.selected-labels',`n=>n.textContent`)).includes('Waiting for PM'),'Second tab stale');
await page.reload();await page.waitForSelector('[data-gtt]');assert.ok((await shadow(page,'.selected-labels',`n=>n.textContent`)).includes('Waiting for PM'));
// Dynamic rows and reused title links must get the correct identity exactly once.
await page.evaluate(()=>{const li=document.querySelector('#modern-row');li.insertAdjacentHTML('afterend','<li><h3><a data-testid="listitem-title-link" href="/pingcap/docs/pull/100">Dynamic PR</a></h3></li>');});
await until(()=>page.locator('[data-gtt="pingcap/docs#100"]').count(),'Dynamic row missing');
await page.evaluate(()=>document.querySelector('a[href="/pingcap/docs/pull/100"]').setAttribute('href','/pingcap/docs/pull/101'));
await until(()=>page.locator('[data-gtt="pingcap/docs#101"]').count(),'Reused link identity stale');
assert.equal(await page.locator('[data-gtt="pingcap/docs#100"]').count(),0);
await page.evaluate(()=>document.dispatchEvent(new Event('turbo:load'))); await page.waitForTimeout(200);assert.equal(await page.locator('[data-gtt]').count(),3);
// React can remove only the injected controls when applying a filter, reusing the title links.
await page.evaluate(()=>{
  history.replaceState({},'',location.pathname+'?q=is%3Apr+is%3Aopen+label%3Adocumentation');
  document.querySelectorAll('[data-gtt]').forEach(node=>node.remove());
});
await until(async()=>await page.locator('[data-gtt]').count()===3,'Filter reconciliation removed private controls permanently');
assert.ok((await shadow(page,'.selected-labels','n=>n.textContent')).includes('Pending by designer'));
// Continuous unrelated rendering must not postpone recovery indefinitely.
await page.evaluate(()=>{
  document.querySelectorAll('[data-gtt]').forEach(node=>node.remove());
  window.noise=document.createElement('div');document.body.append(window.noise);
  window.noiseTimer=setInterval(()=>{window.noise.replaceChildren(document.createElement('span'));},20);
});
try {
  await until(async()=>await page.locator('[data-gtt]').count()===3,'Continuous mutations prevented recovery');
} finally { await page.evaluate(()=>{clearInterval(window.noiseTimer);window.noise.remove();}); }
// Batch mutations, removal, and text-only changes must preserve list integration.
await page.evaluate(()=>{
  const batch=document.createElement('ul');batch.id='batch';
  for(let number=200;number<220;number++){
    const row=document.createElement('li');
    row.innerHTML=`<h3><a data-testid="listitem-title-link" href="/pingcap/docs/pull/${number}">Example PR ${number}</a></h3>`;
    batch.append(row);
  }
  document.body.append(batch);
});
await until(async()=>await page.locator('[data-gtt]').count()===23,'Batch rows missing');
await page.evaluate(()=>{document.querySelector('#batch').remove();document.body.append(document.createTextNode('Example text update'));});
await until(async()=>await page.locator('[data-gtt]').count()===3,'Removed rows were not cleaned up');
// Download a fresh backup through the actual extension settings page.
const downloadPromise=settings.waitForEvent('download');await settings.getByRole('button',{name:'Export JSON'}).click();const download=await downloadPromise;
const backup=JSON.parse(await readFile(await download.path(),'utf8'));assert.equal(backup.pullRequests['pingcap/docs#24528'].length,3);
const snapshot=JSON.stringify(await getState());
await settings.locator('#import').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{"version":999}')});await settings.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Import failed'));
assert.equal(JSON.stringify(await getState()),snapshot);
const replacement={version:1,labels:[{id:'new',name:'Restored label',color:'#123456'}],pullRequests:{'pingcap/docs#24528':['new']}};
await settings.locator('#import').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(replacement))});
await settings.locator('#import-preview:not([hidden])').waitFor();assert.equal(JSON.stringify(await getState()),snapshot);
await settings.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(JSON.stringify(await getState()),snapshot);
await settings.locator('#import').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(replacement))});await settings.getByRole('button',{name:'Replace current data'}).click();
await until(async()=>(await getState()).labels[0].name==='Restored label','Import failed');
await until(async()=>(await shadow(tab2,'.selected-labels',`n=>n.textContent`)).includes('Restored label'),'Import did not broadcast');
// New labels and deletion through their real form/dialog controls.
await settings.getByRole('textbox',{name:'New label name',exact:true}).fill('<img src=x onerror=alert(1)>');await settings.getByRole('button',{name:'Add label',exact:true}).click();await until(async()=>(await getState()).labels.length===2,'Add label failed');
assert.equal(await settings.locator('#labels img').count(),0);
// Modal dismissal must preserve data, and reentrant clicks must not change its target.
const beforeDelete=JSON.stringify(await getState());
async function closeDialog(action) {
  await settings.evaluate(()=>{window.dialogClosed=new Promise(resolve=>document.querySelector('dialog').addEventListener('close',resolve,{once:true}));});
  await action();
  await settings.evaluate(()=>window.dialogClosed.then(()=>true));
}
await settings.getByRole('button',{name:'Delete Restored label',exact:true}).click();
await closeDialog(()=>settings.keyboard.press('Escape'));
await settings.waitForFunction(()=>!document.querySelector('dialog').open);
assert.equal(JSON.stringify(await getState()),beforeDelete);
await settings.evaluate(()=>{const buttons=document.querySelectorAll('.delete');buttons[0].click();buttons[1].click();});
assert.ok((await settings.locator('#delete-description').textContent()).includes('Restored label'));
await closeDialog(()=>settings.locator('dialog').getByRole('button',{name:'Cancel',exact:true}).click());
assert.equal(JSON.stringify(await getState()),beforeDelete);
await settings.evaluate(()=>{const buttons=document.querySelectorAll('.delete');buttons[0].click();document.querySelector('dialog').close('delete');buttons[1].click();});
await until(async()=>Object.keys((await getState()).pullRequests).length===0,'Delete did not clean references');
const afterDelete=await getState();
assert.equal(afterDelete.labels.length,1);
assert.equal(afterDelete.labels[0].name,'<img src=x onerror=alert(1)>','Confirmation deleted a different label');
assert.equal(await settings.locator('dialog').evaluate(dialog=>dialog.open),false);
await settings.setViewportSize({width:390,height:844});await settings.emulateMedia({colorScheme:'dark'});await settings.screenshot({path:join(screenshots, 'settings-mobile-dark.png'),fullPage:true});
assert.ok(await settings.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Settings overflow');
// PR detail pages share the same assignments and expose a distinct sidebar section.
await tab2.goto('https://github.com/pingcap/docs/pull/24528');
await tab2.waitForSelector('[data-gtt][data-placement=sidebar]');
assert.equal(await tab2.locator('[data-gtt]').count(),1);
assert.equal(await tab2.locator('[data-channel-event-name="labels_updated"] + [data-gtt]').count(),1);
const publicLabels=await tab2.locator('.js-issue-labels').innerHTML();
await shadow(tab2,'summary','n=>n.click()');
await until(()=>shadow(tab2,'.panel',`n=>n.matches(':popover-open')`),'Detail editor did not open');
await shadow(tab2,'.choices input','n=>n.click()');
await until(async()=>(await getState()).pullRequests['pingcap/docs#24528']?.length===1,'Detail selection did not save');
await until(async()=>(await shadow(page,'.selected-labels','n=>n.textContent')).includes('<img src=x onerror=alert(1)>'),'Detail selection did not update the list');
await shadow(tab2,'.create-toggle','n=>n.click()');
await shadow(tab2,'.create-fields input[type=text]','n=>{n.value="Detail-created label";}');
await shadow(tab2,'.create-submit','n=>n.click()');
await until(async()=>(await getState()).labels.some(label=>label.name==='Detail-created label'),'Inline creation on detail page failed');
assert.equal(await tab2.locator('.js-issue-labels').innerHTML(),publicLabels,'Public labels were modified');
await shadow(tab2,'.selected-labels',`n=>[...n.querySelectorAll('.tag')].find(tag=>tag.querySelector('.label-name').textContent==='Detail-created label').querySelector('.remove-label').click()`);
await until(async()=>(await getState()).pullRequests['pingcap/docs#24528'].length===1,'Sidebar cross did not remove only its label');
assert.ok((await getState()).labels.some(label=>label.name==='Detail-created label'));
await shadow(tab2,'.footer button:last-child','n=>n.click()');
await shadow(tab2,'.remove-label','n=>n.focus()');
await tab2.keyboard.press('Enter');
await until(async()=>!(await getState()).pullRequests['pingcap/docs#24528'],'Removing the final label left a stale assignment');
await until(()=>shadow(tab2,'summary','(n,root)=>!!n.querySelector(".gtt-plus-icon")&&root.querySelector(".selected-labels").children.length===0'),'Final label removal did not finish updating the sidebar');
assert.equal(await shadow(tab2,'details','n=>n.open'),false,'Keyboard removal opened the editor');
await shadow(tab2,'summary','n=>n.click()');
await shadow(tab2,'.choices label:nth-child(2) input','n=>n.click()');
await until(async()=>(await getState()).pullRequests['pingcap/docs#24528']?.length===1,'Reapplying the label in the sidebar failed');
await tab2.reload();await tab2.waitForSelector('[data-gtt]');
assert.ok((await shadow(tab2,'.selected-labels','n=>n.textContent')).includes('Detail-created label'));
// Empty/dynamically refreshed Labels sections and reused sidebars retain exactly one private section.
await tab2.evaluate(()=>{const section=document.querySelector('[data-channel-event-name="labels_updated"]');const copy=section.cloneNode(true);copy.querySelector('.js-issue-labels').textContent='None yet';section.replaceWith(copy);});
await until(async()=>await tab2.locator('[data-channel-event-name="labels_updated"] + [data-gtt]').count()===1,'Sidebar refresh detached controls');
assert.equal(await tab2.locator('[data-gtt]').count(),1);
await tab2.evaluate(()=>{history.pushState({},'','/pingcap/docs/pull/24529');window.dispatchEvent(new PopStateEvent('popstate'));});
await until(async()=>await tab2.locator('[data-gtt="pingcap/docs#24529"]').count()===1,'Sidebar kept the previous PR identity');
assert.equal(await tab2.locator('[data-gtt="pingcap/docs#24528"]').count(),0);
await tab2.setViewportSize({width:390,height:844});
await shadow(tab2,'summary','n=>n.click()','pingcap/docs#24529');
await until(()=>shadow(tab2,'.panel',`n=>n.matches(':popover-open')`,'pingcap/docs#24529'),'Narrow detail editor did not open');
assert.ok(await shadow(tab2,'.panel',`n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}`,'pingcap/docs#24529'),'Detail editor overflows narrow viewport');
await tab2.screenshot({path:join(screenshots,'detail-mobile.png'),fullPage:true});
const openedTasks=context.waitForEvent('page');
await shadow(tab2,'.footer button:nth-child(2)','n=>n.click()','pingcap/docs#24529');
const myTasks=await openedTasks;
await myTasks.waitForURL(base+'/tasks.html');
await myTasks.locator('#task-results[aria-busy="false"]').waitFor();
assert.ok(await myTasks.locator('#task-rows tr').count()>0,'Editor My tasks entry did not load saved PRs');
// Non-PR pages still receive no controls, even if they have similar sidebar markup.
await tab2.goto('https://github.com/pingcap/docs/issues/24528');
await tab2.waitForTimeout(200);assert.equal(await tab2.locator('[data-gtt]').count(),0);
assert.deepEqual(errors,[]);
console.log('PASS: cross removal and keyboard removal, failed saves, list/detail sync, inline creation, filtering recovery, backups, and responsive layout.');
} finally {
  await context.close();
  await rm(profile,{recursive:true,force:true});
}
