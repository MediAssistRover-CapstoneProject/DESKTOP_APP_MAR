'use strict';

const { execFile: execFileCallback } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Native WLAN returns structured SSIDs on every Windows display language. No
// profile key is queried. Windows may require Location access for SSID queries.
const WLAN_NATIVE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Net.NetworkInformation;
public static class MarNativeWifi {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct IfInfo {
  public Guid id; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)] public string description; public int state;
 }
 [StructLayout(LayoutKind.Sequential)] struct Ssid {
  public uint length; [MarshalAs(UnmanagedType.ByValArray,SizeConst=32)] public byte[] bytes;
 }
 [StructLayout(LayoutKind.Sequential)] struct Association {
  public Ssid ssid; public int bssType;
  [MarshalAs(UnmanagedType.ByValArray,SizeConst=6)] public byte[] bssid;
  public int phyType; public uint phyIndex; public uint signal; public uint rxRate; public uint txRate;
 }
 [StructLayout(LayoutKind.Sequential)] struct Security {
  [MarshalAs(UnmanagedType.Bool)] public bool enabled;
  [MarshalAs(UnmanagedType.Bool)] public bool oneX;
  public int auth; public int cipher;
 }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Connection {
  public int state; public int mode;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)] public string profile;
  public Association association; public Security security;
 }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Profile {
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)] public string name; public uint flags;
 }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Available {
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)] public string profile;
  public Ssid ssid; public int bssType; public uint numberBssids;
  [MarshalAs(UnmanagedType.Bool)] public bool connectable;
  public uint reason; public uint numberPhy;
  [MarshalAs(UnmanagedType.ByValArray,SizeConst=8)] public int[] phy;
  [MarshalAs(UnmanagedType.Bool)] public bool morePhy;
  public uint signal;
  [MarshalAs(UnmanagedType.Bool)] public bool secure;
  public int auth; public int cipher; public uint flags; public uint reserved;
 }
 [DllImport("wlanapi.dll")] static extern uint WlanOpenHandle(uint version,IntPtr reserved,out uint negotiated,out IntPtr handle);
 [DllImport("wlanapi.dll")] static extern uint WlanCloseHandle(IntPtr handle,IntPtr reserved);
 [DllImport("wlanapi.dll")] static extern uint WlanEnumInterfaces(IntPtr handle,IntPtr reserved,out IntPtr list);
 [DllImport("wlanapi.dll")] static extern uint WlanQueryInterface(IntPtr handle,ref Guid id,int opcode,IntPtr reserved,out uint size,out IntPtr data,out int valueType);
 [DllImport("wlanapi.dll")] static extern uint WlanGetProfileList(IntPtr handle,ref Guid id,IntPtr reserved,out IntPtr list);
 [DllImport("wlanapi.dll")] static extern uint WlanGetAvailableNetworkList(IntPtr handle,ref Guid id,uint flags,IntPtr reserved,out IntPtr list);
 [DllImport("wlanapi.dll")] static extern void WlanFreeMemory(IntPtr memory);
 static string Text(Ssid value) {
  return value.bytes==null?"":Encoding.UTF8.GetString(value.bytes,0,(int)Math.Min(value.length,32));
 }
 static object Item(params object[] fields) {
  var row=new Dictionary<string,object>();
  for(int n=0;n<fields.Length;n+=2)row[(string)fields[n]]=fields[n+1];return row;
 }
 static string State(int state) {
  string[] values={"notReady","connected","adHoc","disconnecting","disconnected","associating","discovering","authenticating"};
  return state>=0&&state<values.Length?values[state]:"unknown";
 }
 static string Name(IfInfo info) {
  foreach(var nic in NetworkInterface.GetAllNetworkInterfaces())
   if(String.Equals(nic.Id,info.id.ToString(),StringComparison.OrdinalIgnoreCase)||String.Equals(nic.Id,"{"+info.id.ToString()+"}",StringComparison.OrdinalIgnoreCase))return nic.Name;
  return info.description;
 }
 public static object Read(bool includeNetworks) {
  var interfaces=new List<object>();var profiles=new List<object>();var networks=new List<object>();var errors=new List<object>();
  IntPtr handle=IntPtr.Zero,list=IntPtr.Zero;uint version;uint result=WlanOpenHandle(2,IntPtr.Zero,out version,out handle);
  if(result!=0)return Item("supported",true,"interfaces",interfaces,"profiles",profiles,"networks",networks,"errorCode",result);
  try {
   result=WlanEnumInterfaces(handle,IntPtr.Zero,out list);
   if(result!=0)return Item("supported",true,"interfaces",interfaces,"profiles",profiles,"networks",networks,"errorCode",result);
   int count=Math.Min(Marshal.ReadInt32(list),32),stride=Marshal.SizeOf(typeof(IfInfo));
   for(int i=0;i<count;i++) {
    var info=(IfInfo)Marshal.PtrToStructure(IntPtr.Add(list,8+i*stride),typeof(IfInfo));var id=info.id;string name=Name(info),ssid=null,profile=null;uint signal=0;
    IntPtr data=IntPtr.Zero;uint size;int kind;
    result=WlanQueryInterface(handle,ref id,7,IntPtr.Zero,out size,out data,out kind);
    try {if(result==0&&data!=IntPtr.Zero) {var current=(Connection)Marshal.PtrToStructure(data,typeof(Connection));ssid=Text(current.association.ssid);profile=current.profile;signal=current.association.signal;}}
    finally {if(data!=IntPtr.Zero)WlanFreeMemory(data);}
    if(result==5)errors.Add(Item("interfaceName",name,"errorCode",result,"operation","connection"));
    interfaces.Add(Item("name",name,"id",id.ToString(),"description",info.description,"state",State(info.state),"ssid",ssid,"profileName",profile,"signal",signal));
    IntPtr entries=IntPtr.Zero;result=WlanGetProfileList(handle,ref id,IntPtr.Zero,out entries);
    try {if(result==0) {int n=Math.Min(Marshal.ReadInt32(entries),512),step=Marshal.SizeOf(typeof(Profile));for(int j=0;j<n;j++){var p=(Profile)Marshal.PtrToStructure(IntPtr.Add(entries,8+j*step),typeof(Profile));profiles.Add(Item("name",p.name,"interfaceName",name));}}}
    finally {if(entries!=IntPtr.Zero)WlanFreeMemory(entries);}
    if(!includeNetworks)continue;
    entries=IntPtr.Zero;result=WlanGetAvailableNetworkList(handle,ref id,0,IntPtr.Zero,out entries);
    try {if(result==0) {int n=Math.Min(Marshal.ReadInt32(entries),512),step=Marshal.SizeOf(typeof(Available));for(int j=0;j<n;j++){var p=(Available)Marshal.PtrToStructure(IntPtr.Add(entries,8+j*step),typeof(Available));string value=Text(p.ssid);if(value.Length>0)networks.Add(Item("ssid",value,"signal",p.signal,"secure",p.secure,"profileName",p.profile,"interfaceName",name,"connectable",p.connectable));}}else errors.Add(Item("interfaceName",name,"errorCode",result,"operation","networks"));}
    finally {if(entries!=IntPtr.Zero)WlanFreeMemory(entries);}
   }
   return Item("supported",true,"interfaces",interfaces,"profiles",profiles,"networks",networks,"errors",errors);
  } finally {if(list!=IntPtr.Zero)WlanFreeMemory(list);if(handle!=IntPtr.Zero)WlanCloseHandle(handle,IntPtr.Zero);}
 }
}
`;

function validateText(value, name, maxBytes) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/u.test(value) || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`${name} không hợp lệ.`);
  }
  return value;
}

function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function generatedProfileName(ssid) {
  return `MAR-${crypto.createHash('sha256').update(ssid).digest('hex').slice(0, 16)}`;
}

function assertOwnedTempFolder(folder, parent) {
  const target = path.resolve(folder);
  const intendedParent = path.resolve(parent);
  if (path.dirname(target) !== intendedParent || !path.basename(target).startsWith('mar-wifi-')) {
    throw new Error('Từ chối dọn thư mục tạm nằm ngoài thư mục ứng dụng đã tạo.');
  }
  return target;
}

function profileXml(ssid, password, profileName) {
  validateText(ssid, 'SSID', 32);
  validateText(profileName, 'Tên cấu hình Wi-Fi', 256);
  if (typeof password !== 'string' || !(/^[\x20-\x7e]{8,63}$/.test(password) || /^[a-f\d]{64}$/i.test(password))) {
    throw new Error('Wi-Fi mới cần mật khẩu WPA2 gồm 8–63 ký tự ASCII hoặc 64 ký tự hex. Mạng doanh nghiệp dùng cấu hình Windows đã lưu.');
  }
  const keyType = password.length === 64 ? 'networkKey' : 'passPhrase';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1"><name>${escapeXml(profileName)}</name><SSIDConfig><SSID><hex>${Buffer.from(ssid, 'utf8').toString('hex').toUpperCase()}</hex><name>${escapeXml(ssid)}</name></SSID></SSIDConfig><connectionType>ESS</connectionType><connectionMode>manual</connectionMode><MSM><security><authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption><sharedKey><keyType>${keyType}</keyType><protected>false</protected><keyMaterial>${escapeXml(password)}</keyMaterial></sharedKey></security></MSM></WLANProfile>`;
}

function createWindowsWifi(dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const execFile = dependencies.execFile || promisify(execFileCallback);
  const io = dependencies.fs || fs;
  const tempRoot = dependencies.tmpdir || os.tmpdir;

  async function read(includeNetworks) {
    if (platform !== 'win32') return { supported: false, interfaces: [], profiles: [], networks: [], message: 'Đổi Wi-Fi trên laptop chỉ hỗ trợ Windows.' };
    const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Add-Type -TypeDefinition @'\n${WLAN_NATIVE}\n'@;[MarNativeWifi]::Read($${includeNetworks ? 'true' : 'false'}) | ConvertTo-Json -Depth 8 -Compress`;
    try {
      const result = await execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, timeout: 18000, maxBuffer: 1024 * 1024, encoding: 'utf8'
      });
      const value = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
      value.interfaces = Array.isArray(value.interfaces) ? value.interfaces : [];
      value.profiles = Array.isArray(value.profiles) ? value.profiles : [];
      value.networks = Array.isArray(value.networks) ? value.networks : [];
      if (value.errorCode || value.errors?.length) value.message = 'Windows chưa trả đầy đủ thông tin Wi-Fi. Kiểm tra Wi-Fi và quyền Location trong Settings.';
      return value;
    } catch {
      return { supported: true, interfaces: [], profiles: [], networks: [], message: 'Không đọc được Wi-Fi Windows. Có thể chọn mạng trong Windows Settings rồi thử lại.' };
    }
  }

  async function connectWifi(input = {}) {
    if (platform !== 'win32') throw new Error('Chức năng đổi Wi-Fi laptop chỉ hỗ trợ Windows.');
    const ssid = validateText(input.ssid, 'SSID', 32);
    const interfaceName = input.interfaceName ? validateText(input.interfaceName, 'Wi-Fi adapter', 256) : null;
    let profileName = input.profileName ? validateText(input.profileName, 'Tên cấu hình Wi-Fi', 256) : null;
    const options = { windowsHide: true, timeout: 12000, maxBuffer: 65536, encoding: 'utf8' };
    let folder, temporaryParent;
    try {
      if (typeof input.password === 'string' && input.password.length) {
        profileName = generatedProfileName(ssid);
        const xml = profileXml(ssid, input.password, profileName);
        temporaryParent = await io.realpath(path.resolve(tempRoot()));
        folder = await io.mkdtemp(path.join(temporaryParent, 'mar-wifi-'));
        assertOwnedTempFolder(await io.realpath(folder), temporaryParent);
        const filename = path.join(folder, 'profile.xml');
        await io.writeFile(filename, xml, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        const args = ['wlan', 'add', 'profile', `filename=${filename}`, 'user=current'];
        if (interfaceName) args.push(`interface=${interfaceName}`);
        await execFile('netsh.exe', args, options);
      } else if (!profileName) {
        const status = await read(false);
        const active = status.interfaces.find(row => row.ssid === ssid && row.profileName);
        const generated = generatedProfileName(ssid);
        const remembered = status.profiles.find(row => (row.name === ssid || row.name === generated)
          && (!interfaceName || row.interfaceName === interfaceName));
        profileName = active?.profileName || remembered?.name;
        if (!profileName) throw new Error('Mạng chưa có cấu hình Windows. Nhập mật khẩu hoặc chọn tên profile đã lưu.');
      }
      const args = ['wlan', 'connect', `name=${profileName}`, `ssid=${ssid}`];
      if (interfaceName) args.push(`interface=${interfaceName}`);
      await execFile('netsh.exe', args, options);
      return { started: true, ssid, profileName, message: 'Đã gửi yêu cầu chuyển mạng. Chờ Windows kết nối rồi tìm lại robot.' };
    } catch (error) {
      if (error?.message?.startsWith('Mạng chưa')) throw error;
      // Never return subprocess stdout/stderr: Windows errors can echo profile data.
      throw new Error('Windows chưa chuyển được Wi-Fi. Kiểm tra mật khẩu/profile hoặc kết nối trong Windows Settings.');
    } finally {
      if (folder) {
        // Verify the resolved absolute target immediately before recursive
        // removal; a computed or replaced path must never escape this parent.
        let resolved;
        try { resolved = await io.realpath(folder); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (resolved) await io.rm(assertOwnedTempFolder(resolved, temporaryParent), { recursive: true, force: true });
      }
    }
  }
  return { getWifiStatus: () => read(false), listWifiNetworks: () => read(true), connectWifi };
}

module.exports = { ...createWindowsWifi(), createWindowsWifi, profileXml, validateText };
