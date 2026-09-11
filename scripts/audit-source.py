"""Inspect the staged release manifest, without printing credential values."""
import json,re,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
actual=Path(subprocess.check_output(['git','rev-parse','--show-toplevel'],cwd=root).decode().strip()).resolve()
if actual!=root.resolve():raise SystemExit('Refusing to inspect a parent repository')
files=subprocess.check_output(['git','ls-files','--cached','-z'],cwd=root).decode('utf-8').split('\0')
if not any(files):raise SystemExit('Release manifest is empty')
rules={
 'private key':r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
 'GitHub credential':r'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}',
 'API credential':r'sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}',
 'cloud credential':r'AKIA[0-9A-Z]{16}',
 'personal profile path':r'[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b|Default\b)[^\\/\s]+',
 'chat identifier':r'wxid_[A-Za-z0-9_]{6,}',
 'assigned secret':r'''(?i)(?:api[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*["'][A-Za-z0-9_./+-]{16,}["']''',
}
forbidden={'.db','.sqlite','.sqlite3','.spc','.pem','.key','.pfx','.p12','.log','.exe','.dll'}
findings=[];total=0
for name in filter(None,files):
 p=root/name;total+=1
 if p.suffix.lower() in forbidden or any(part in ('.git','node_modules','target','.test-env','reference','astra-star-animation') for part in p.relative_to(root).parts):findings.append({'file':name,'reason':'forbidden release file'})
 if p.suffix.lower() in ('.jpg','.jpeg','.png','.ico','.icns'):continue
 try:text=p.read_text(encoding='utf-8')
 except UnicodeError:findings.append({'file':name,'reason':'unreviewed binary'});continue
 for label,pattern in rules.items():
  if re.search(pattern,text):findings.append({'file':name,'reason':label})
print(json.dumps({'files':total,'findings':findings},ensure_ascii=False,indent=2))
sys.exit(bool(findings))
