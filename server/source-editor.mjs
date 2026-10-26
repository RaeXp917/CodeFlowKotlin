// Existing UTF-8 source files only. All replacement writes are local, versioned
// and authorized against a live registered-project snapshot.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TextDecoder } from 'node:util';
import { isSourceCodeFile, makeExcludeMatcher, shouldSkipName, SOURCE_FILE_MAX_BYTES } from './server-utils.mjs';
export const EDIT_BODY_MAX_BYTES = SOURCE_FILE_MAX_BYTES * 6 + 4096;
export class SourceEditError extends Error {
  constructor(status, code, message) { super(message); this.status=status; this.code=code; }
}
const fail=(status,code,message)=>{throw new SourceEditError(status,code,message);};
export function createSourceEditor(getScope, { io=fs }={}) {
  const salt=crypto.randomBytes(32);
  function version(scope,relative,stat,bytes){return crypto.createHash('sha256').update(salt).update(String(scope.generation)).update(scope.projectId).update(relative).update(JSON.stringify([stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs,stat.mode])).update(bytes).digest('hex');}
  function sameFileState(a,b){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&a.mode===b.mode;}
  function live(captured){const now=getScope();if(!now.root||now.projectId!==captured.projectId||now.root!==captured.root||now.generation!==captured.generation||now.exclusions!==captured.exclusions)fail(409,'scope-changed','Project or exclusions changed. Reopen the file.');}
  function scopeFor(pid){const scope=getScope();if(!pid||pid!==scope.projectId||!scope.root)fail(409,'scope-changed','Select the active registered project.');return scope;}
  function target(scope,relative){
    live(scope);
    if(typeof relative!=='string'||!relative||relative.length>4096||/[\\:\x00-\x1f]/.test(relative)||relative.startsWith('/')||relative.split('/').some(p=>!p||p==='.'||p==='..'||p.endsWith('.')||p.endsWith(' ')||shouldSkipName(p))||!isSourceCodeFile(relative.split('/').pop())||makeExcludeMatcher(scope.exclusions)(relative))fail(404,'ineligible','Eligible source file not available.');
    let current=scope.root;
    // Reject links for editing, including internal links, so an editor is bound
    // to one regular pathname rather than an alias that can be redirected.
    if(io.realpathSync(scope.root)!==scope.root)fail(409,'scope-changed','Project root changed.');
    for(const part of relative.split('/')){current=path.join(current,part);const st=io.lstatSync(current);if(st.isSymbolicLink())fail(404,'ineligible','Linked files or folders cannot be edited.');}
    const st=io.statSync(current);
    if(!st.isFile()||st.nlink>1)fail(404,'ineligible','Only existing regular source files can be edited.');
    if(st.size>SOURCE_FILE_MAX_BYTES)fail(413,'too-large','Source exceeds the editor size limit.');
    if((st.mode&0o222)===0)fail(403,'read-only','Source is read-only.');
    return {file:current,stat:st};
  }
  function readBytes(file,stat){
    const fd=io.openSync(file,'r');
    try{const actual=io.fstatSync(fd);if(!sameFileState(actual,stat))fail(409,'conflict','Source changed while opening. Reload it.');if(actual.size>SOURCE_FILE_MAX_BYTES)fail(413,'too-large','Source exceeds the editor size limit.');const bytes=io.readFileSync(fd);if(bytes.length>SOURCE_FILE_MAX_BYTES)fail(413,'too-large','Source exceeds the editor size limit.');const after=io.fstatSync(fd);if(!sameFileState(actual,after)||bytes.length!==after.size)fail(409,'conflict','Source changed while reading. Reload it.');return {bytes,stat:after};}finally{io.closeSync(fd);}
  }
  function textInfo(bytes){
    const bom=bytes.length>=3&&bytes[0]===239&&bytes[1]===187&&bytes[2]===191;
    let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bom?bytes.subarray(3):bytes);}catch{fail(422,'encoding','Editor supports UTF-8 text source only.');}
    if(text.includes('\0'))fail(422,'encoding','Binary source containers cannot be edited as text.');
    const crlf=(text.match(/\r\n/g)||[]).length,lf=(text.match(/(?<!\r)\n/g)||[]).length;
    if(/\r(?!\n)/.test(text)||(crlf&&lf))fail(422,'line-endings','Mixed or CR-only line endings require an external editor.');
    return {content:text.replace(/\r\n/g,'\n'),bom,lineEnding:crlf?'CRLF':'LF'};
  }
  function run(fn){try{return fn();}catch(e){if(e instanceof SourceEditError)throw e;if(['EACCES','EPERM','EROFS'].includes(e.code))fail(403,'permission','Source cannot be written with current permissions.');if(['ENOENT','ENOTDIR','ELOOP'].includes(e.code))fail(404,'missing','Source file or project is no longer available.');fail(500,'disk-error','Local disk operation failed; the source was not replaced.');}}
  return {
    read(pid,relative){return run(()=>{const scope=scopeFor(pid),t=target(scope,relative),read=readBytes(t.file,t.stat),info=textInfo(read.bytes);live(scope);return {...info,projectId:pid,path:relative,version:version(scope,relative,read.stat,read.bytes)};});},
    save(input){return run(()=>{
      if(!input||typeof input.content!=='string'||typeof input.version!=='string'||!/^[a-f0-9]{64}$/.test(input.version)||input.content.includes('\0'))fail(400,'payload','Invalid source save payload.');
      if(Buffer.from(input.content,'utf8').toString('utf8')!==input.content)fail(422,'encoding','Edited source contains an invalid Unicode sequence.');
      if(Buffer.byteLength(input.content,'utf8')>SOURCE_FILE_MAX_BYTES)fail(413,'too-large','Edited source exceeds the size limit.');
      const scope=scopeFor(input.projectId),t=target(scope,input.path),original=readBytes(t.file,t.stat),info=textInfo(original.bytes);
      if(version(scope,input.path,original.stat,original.bytes)!==input.version)fail(409,'conflict','Source changed externally or the editor session expired. Your draft is preserved; reload to resolve.');
      const content=input.content.replace(/\r\n|\r/g,'\n'),diskText=content.replace(/\n/g,info.lineEnding==='CRLF'?'\r\n':'\n');
      const bytes=Buffer.concat([info.bom?Buffer.from([239,187,191]):Buffer.alloc(0),Buffer.from(diskText,'utf8')]);
      if(bytes.length>SOURCE_FILE_MAX_BYTES)fail(413,'too-large','Encoded source exceeds the size limit.');
      const temporary=path.join(path.dirname(t.file),'.codeflow-edit-'+crypto.randomUUID()+'.tmp');let fd;
      try{
        // Opening r+ does not truncate; it checks the original Windows read-only
        // attribute / ACL before attempting an atomic directory replacement.
        const check=io.openSync(t.file,'r+');io.closeSync(check);
        io.copyFileSync(t.file,temporary,fs.constants.COPYFILE_EXCL);
        fd=io.openSync(temporary,'r+');io.ftruncateSync(fd,0);io.writeFileSync(fd,bytes);io.fsyncSync(fd);io.fchmodSync(fd,t.stat.mode&0o777);io.closeSync(fd);fd=undefined;
        const final=target(scope,input.path),latest=readBytes(final.file,final.stat);
        if(final.file!==t.file||version(scope,input.path,latest.stat,latest.bytes)!==input.version)fail(409,'conflict','Source changed externally before replacement. Draft preserved.');
        live(scope);io.renameSync(temporary,t.file);
        return {projectId:input.projectId,path:input.path,content,bom:info.bom,lineEnding:info.lineEnding,version:version(scope,input.path,io.statSync(t.file),bytes),saved:true};
      }finally{if(fd!==undefined)try{io.closeSync(fd);}catch{}try{io.unlinkSync(temporary);}catch(e){if(e.code!=='ENOENT')console.error('CodeFlow: temporary source cleanup failed');}}
    });}
  };
}
