// Fixed source only. All runtime values arrive as JSON on stdin, never as
// PowerShell or C# source. Windows PowerShell 5.1 supplies the .NET compiler.
export const windowsJobSource = String.raw`
$ErrorActionPreference = 'Stop'
try {
Add-Type -ReferencedAssemblies System.dll,System.Core.dll,System.Web.Extensions.dll -TypeDefinition @'
using System;
using System.Text;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

public static class DomovoiJob {
  const uint KILL_ON_CLOSE = 0x2000;
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorking, MaxWorking;
    public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUser, PeriodKernel;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint Size; public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags; public ushort Show, ReservedSize;
    public IntPtr ReservedPointer, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Basic; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
  [StructLayout(LayoutKind.Sequential)] struct Security { public int Size; public IntPtr Descriptor; public int Inherit; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", EntryPoint="QueryInformationJobObject", SetLastError=true)] static extern bool QueryLimits(IntPtr job, int kind, out ExtendedLimits limits, uint size, IntPtr returned);
  [DllImport("kernel32.dll", EntryPoint="QueryInformationJobObject", SetLastError=true)] static extern bool QueryAccounting(IntPtr job, int kind, out Accounting accounting, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint sharing, ref Security security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool MoveFileEx(string from, string to, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  delegate IntPtr WindowProcedure(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct WindowClass {
    public uint Size, Style; public IntPtr Procedure; public int ClassExtra, WindowExtra;
    public IntPtr Instance, Icon, Cursor, Background; public string Menu, Name; public IntPtr SmallIcon;
  }
  [StructLayout(LayoutKind.Sequential)] struct WindowMessage {
    public IntPtr Window; public uint Message; public UIntPtr W; public IntPtr L; public uint Time; public int X, Y; public uint Private;
  }
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern ushort RegisterClassEx(ref WindowClass cls);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateWindowEx(uint extended, string cls, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr DefWindowProc(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll", SetLastError=true)] static extern int GetMessage(out WindowMessage message, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref WindowMessage message);
  [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern void PostQuitMessage(int code);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool UnregisterClass(string name, IntPtr instance);
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Emit(object value) { Console.Out.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
  static string Boot() {
    // KUSER_SHARED_DATA.BootId on Windows 10+: read-only shared kernel data
    // at the fixed user mapping. This unsigned boot counter does not derive
    // from wall time, uptime, a logon session, or the BCD OS-loader GUID.
    uint counter = unchecked((uint)Marshal.ReadInt32(new IntPtr(0x7FFE02C4)));
    return "windows-boot:" + counter.ToString(System.Globalization.CultureInfo.InvariantCulture);
  }
  static object Identity(IntPtr handle, uint pid, string boot) {
    long created, exited, kernel, user;
    Check(GetProcessTimes(handle, out created, out exited, out kernel, out user));
    return new { pid=pid, start=created.ToString(System.Globalization.CultureInfo.InvariantCulture), bootId=boot.ToString() };
  }
  static object InspectProcess(uint pid, string boot) {
    IntPtr handle = OpenProcess(0x101000, false, pid);
    if (handle == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      if (error != 87) throw new Win32Exception(error);
      return null;
    }
    try {
      uint waited = WaitForSingleObject(handle, 0);
      if (waited != 0 && waited != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
      return waited == 0 ? null : Identity(handle, pid, boot);
    } finally { CloseHandle(handle); }
  }
  public static void Inspect(uint[] pids) {
    string boot = Boot();
    var identities = new System.Collections.Generic.List<object>();
    foreach (uint pid in pids) identities.Add(InspectProcess(pid, boot));
    Emit(new { bootId=boot, identities=identities });
  }
  // CommandLineToArgvW/CRT quoting, with an explicit application path. No shell.
  static string Quote(string value) {
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { ++slashes; continue; }
      result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); result.Append(c); slashes = 0;
    }
    result.Append('\\', slashes * 2); return result.Append('"').ToString();
  }
  static uint Active(IntPtr job) {
    Accounting data; Check(QueryAccounting(job, 1, out data, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
    return data.ActiveProcesses;
  }
  static bool Ended(IntPtr process) {
    uint answer = WaitForSingleObject(process, 0);
    if (answer == 0) return true;
    if (answer == 258) return false;
    throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  // The retained job handle outlives this object. Finish serializes the main
  // loop, stdin EOF and session-end paths, so only one receipt is published.
  sealed class JobLifetime : IDisposable {
    readonly object gate = new object(); readonly IntPtr job; readonly string name, boot, path, registration;
    readonly int attempt; readonly object child, helper;
    readonly ManualResetEventSlim ready = new ManualResetEventSlim(false);
    readonly WindowProcedure procedure;
    Thread thread; IntPtr window; volatile Exception windowError; bool disposed; object empty;
    public volatile bool SessionEnded;
    public JobLifetime(IntPtr handle, string jobName, string bootId, string receiptPath, string registrationId, int number, object childId, object helperId) {
      job=handle; name=jobName; boot=bootId; path=receiptPath; registration=registrationId; attempt=number; child=childId; helper=helperId;
      procedure = OnMessage;
    }
    void Publish(object receipt) {
      string staging = path + "." + Guid.NewGuid().ToString() + ".partial";
      var acl = new FileSecurity();
      using (var identity = WindowsIdentity.GetCurrent()) {
        acl.SetOwner(identity.User); acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new FileSystemAccessRule(identity.User, FileSystemRights.FullControl, AccessControlType.Allow));
      }
      try {
        byte[] bytes = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(receipt) + "\n");
        using (var file = new FileStream(staging, FileMode.CreateNew, FileSystemRights.Write | FileSystemRights.Synchronize, FileShare.None, 4096, FileOptions.WriteThrough, acl)) {
          file.Write(bytes, 0, bytes.Length); file.Flush(true);
        }
        // Same-directory atomic rename, no replacement of an existing receipt.
        // MOVEFILE_WRITE_THROUGH follows the FlushFileBuffers above.
        Check(MoveFileEx(staging, path, 8));
      } finally { if (File.Exists(staging)) File.Delete(staging); }
    }
    public object Finish(uint code, bool stopped) {
      lock (gate) {
        if (disposed) throw new InvalidOperationException("Job observer is closed");
        if (empty != null) return empty;
        Check(TerminateJobObject(job, 1));
        var stopping = Stopwatch.StartNew();
        while (Active(job) != 0) {
          if (stopping.ElapsedMilliseconds > 10000) throw new InvalidOperationException("Job remains nonempty");
          Thread.Sleep(25);
        }
        Publish(new { version=1, kind="empty", job=name, bootId=boot, registrationId=registration, attempt=attempt,
          at=DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture),
          child=child, helper=helper, activeProcesses=0, terminated=true, code=code, stopped=stopped });
        empty = new { kind="empty", job=name, bootId=boot, activeProcesses=0, terminated=true, code=code, stopped=stopped };
        return empty;
      }
    }
    IntPtr OnMessage(IntPtr hwnd, uint message, IntPtr w, IntPtr l) {
      // WM_QUERYENDSESSION may be canceled. Acknowledge without killing the
      // daemon; WM_ENDSESSION(TRUE) does the synchronous proof and publication.
      if (message == 0x11) return new IntPtr(1);
      if (message == 0x16 && w != IntPtr.Zero) {
        try { Finish(1, true); } catch (Exception error) { windowError = error; }
        finally { SessionEnded = true; }
        return IntPtr.Zero;
      }
      if (message == 0x10) { DestroyWindow(hwnd); window=IntPtr.Zero; PostQuitMessage(0); return IntPtr.Zero; }
      return DefWindowProc(hwnd, message, w, l);
    }
    public void CheckWindow() { if (windowError != null) throw new InvalidOperationException("Session-end observer failed", windowError); }
    public void StartWindow() {
      thread = new Thread(() => {
        string clsName = "DomovoiJob-" + Guid.NewGuid().ToString(); IntPtr instance = GetModuleHandle(null); bool registered=false;
        try {
          WindowClass cls = new WindowClass(); cls.Size=(uint)Marshal.SizeOf(typeof(WindowClass)); cls.Name=clsName;
          cls.Instance=instance; cls.Procedure=Marshal.GetFunctionPointerForDelegate(procedure);
          Check(RegisterClassEx(ref cls) != 0); registered=true;
          // Hidden TOP-LEVEL window: no WS_VISIBLE, no parent, never HWND_MESSAGE.
          // Message-only windows do not receive end-session broadcasts.
          window=CreateWindowEx(0x80, clsName, name, 0, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
          Check(window != IntPtr.Zero); ready.Set();
          WindowMessage message; int next;
          while ((next=GetMessage(out message, IntPtr.Zero, 0, 0)) > 0) DispatchMessage(ref message);
          Check(next == 0);
        } catch (Exception error) { windowError=error; SessionEnded=true; }
        finally {
          ready.Set();
          if (window != IntPtr.Zero) { DestroyWindow(window); window=IntPtr.Zero; }
          if (registered) UnregisterClass(clsName, instance);
        }
      });
      thread.IsBackground=true; thread.Start(); ready.Wait(); CheckWindow();
    }
    public void Dispose() {
      // Wait for any synchronous receipt write before the caller closes the
      // job. A late window message must never query that closed/reused handle.
      lock (gate) { disposed=true; }
      if (window != IntPtr.Zero) PostMessage(window, 0x10, IntPtr.Zero, IntPtr.Zero);
      if (thread != null) thread.Join(2000);
      GC.KeepAlive(procedure);
    }
  }
  public static void Run(string name, string executable, string[] args, string log, string receiptPath, string registration, int attempt, string expectedBoot) {
    Guid id;
    if (!name.StartsWith("Local\\Domovoi-") || !Guid.TryParse(name.Substring(14), out id)) throw new InvalidOperationException("Invalid job name");
    string boot = Boot(); Guid registrationId;
    if (boot != expectedBoot || !Guid.TryParse(registration, out registrationId) || attempt < 1 || attempt > 4)
      throw new InvalidOperationException("Invalid receipt binding");
    if (!Path.IsPathRooted(receiptPath) || Path.GetFileName(receiptPath) != "windows-job-" + id.ToString() + ".receipt.json"
      || (File.GetAttributes(Path.GetDirectoryName(receiptPath)) & FileAttributes.ReparsePoint) != 0)
      throw new InvalidOperationException("Invalid receipt path");
    IntPtr job = CreateJobObject(IntPtr.Zero, name);
    int createError = Marshal.GetLastWin32Error();
    if (job == IntPtr.Zero) throw new Win32Exception(createError);
    if (createError == 183) { CloseHandle(job); throw new InvalidOperationException("Job name already exists"); }
    ProcessInfo child = new ProcessInfo(); IntPtr output = IntPtr.Zero, input = IntPtr.Zero;
    IntPtr attributes = IntPtr.Zero, inherited = IntPtr.Zero;
    bool assigned = false, initialized = false; JobLifetime lifetime = null;
    try {
      ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = KILL_ON_CLOSE;
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      ExtendedLimits actual;
      Check(QueryLimits(job, 9, out actual, (uint)Marshal.SizeOf(typeof(ExtendedLimits)), IntPtr.Zero));
      if ((actual.Basic.Flags & KILL_ON_CLOSE) == 0 || (actual.Basic.Flags & 0x1800) != 0) throw new InvalidOperationException("Job limits not confirmed");
      Security security = new Security(); security.Size = Marshal.SizeOf(typeof(Security)); security.Inherit = 1;
      output = CreateFile(log, 0x0004, 3, ref security, 4, 0x80, IntPtr.Zero);
      if (output == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
      input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0x80, IntPtr.Zero);
      if (input == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
      // Only NUL and the daemon log may cross this boundary. In particular,
      // the helper's evidence and command pipes must not enter the job tree.
      IntPtr attributeSize = IntPtr.Zero;
      bool sized = InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
      if (sized || Marshal.GetLastWin32Error() != 122 || attributeSize.ToInt64() <= 0 || attributeSize.ToInt64() > 65536)
        throw new InvalidOperationException("Handle-list size unavailable");
      attributes = Marshal.AllocHGlobal(attributeSize);
      Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref attributeSize)); initialized = true;
      inherited = Marshal.AllocHGlobal(IntPtr.Size * 2);
      Marshal.WriteIntPtr(inherited, 0, input); Marshal.WriteIntPtr(inherited, IntPtr.Size, output);
      // PROC_THREAD_ATTRIBUTE_HANDLE_LIST. bInheritHandles must still be true.
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), inherited, new IntPtr(IntPtr.Size * 2), IntPtr.Zero, IntPtr.Zero));
      StartupEx startup = new StartupEx(); startup.Basic.Size = (uint)Marshal.SizeOf(typeof(StartupEx));
      startup.Basic.Flags = 0x100; startup.Basic.Input = input; startup.Basic.Output = output; startup.Basic.Error = output;
      startup.Attributes = attributes;
      var command = new StringBuilder(Quote(executable)); foreach (string arg in args) command.Append(' ').Append(Quote(arg));
      // CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT.
      Check(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x08080004, IntPtr.Zero, null, ref startup, out child));
      Check(AssignProcessToJobObject(job, child.Process)); assigned = true;
      object childId=Identity(child.Process, child.Pid, boot), helperId;
      using (Process self = Process.GetCurrentProcess()) { helperId=Identity(self.Handle, (uint)self.Id, boot); }
      lifetime = new JobLifetime(job, name, boot, receiptPath, registration, attempt, childId, helperId);
      lifetime.StartWindow();
      Emit(new { kind="prepared", job=name, bootId=boot, child=childId, helper=helperId, killOnClose=true, stdioOnly=true });
      var commands = new BlockingCollection<string>();
      var reader = new Thread(() => {
        try { string line; while ((line = Console.In.ReadLine()) != null) commands.Add(line); }
        catch (IOException) { /* A broken input pipe also requests cleanup. */ }
        finally { commands.Add("{\"command\":\"stop\"}"); }
      }); reader.IsBackground = true; reader.Start();
      bool resumed = false, stopped = false;
      var handshake = Stopwatch.StartNew();
      while (!Ended(child.Process) && !lifetime.SessionEnded) {
        string message;
        if (commands.TryTake(out message, 50)) {
          var control = Json.Deserialize<System.Collections.Generic.Dictionary<string,string>>(message);
          if (control["command"] == "stop") { stopped = true; break; }
          if (control["command"] != "resume" || resumed) throw new InvalidOperationException("Invalid helper command");
          if (ResumeThread(child.Thread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
          resumed = true; Emit(new { kind="running", job=name });
        }
        if (!resumed && handshake.ElapsedMilliseconds > 15000) throw new InvalidOperationException("Startup acknowledgement expired");
      }
      lifetime.CheckWindow();
      stopped = stopped || lifetime.SessionEnded;
      uint code = 1;
      if (!stopped) Check(GetExitCodeProcess(child.Process, out code));
      // The helper's own flushed receipt precedes stdout, which may already be
      // closed because the Node supervisor died. Broken stdout cannot lose proof.
      Emit(lifetime.Finish(code, stopped));
    } finally {
      if (lifetime != null) {
        try { lifetime.Finish(1, true); } catch { /* Missing receipt remains unconfirmed. */ }
        lifetime.Dispose();
      }
      if (initialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (inherited != IntPtr.Zero) Marshal.FreeHGlobal(inherited);
      // Assignment failure may leave a suspended, unassigned process. Attempt
      // cleanup, but emit no success evidence for an interrupted launch.
      if (child.Process != IntPtr.Zero && !assigned) { TerminateProcess(child.Process, 1); WaitForSingleObject(child.Process, 10000); }
      if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
      if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
      if (input != IntPtr.Zero && input != new IntPtr(-1)) CloseHandle(input);
      if (output != IntPtr.Zero && output != new IntPtr(-1)) CloseHandle(output);
      CloseHandle(job);
    }
  }
}
'@
$request = [Console]::In.ReadLine() | ConvertFrom-Json
if ($request.mode -eq 'inspect') { [DomovoiJob]::Inspect([uint32[]]@($request.pids)) }
elseif ($request.mode -eq 'run') {
  # Windows PowerShell rewrites this variable at startup. Restore the Node
  # supervisor's value (including absence) before the daemon inherits it.
  [Environment]::SetEnvironmentVariable('PSModulePath', $request.psModulePath, [EnvironmentVariableTarget]::Process)
  [DomovoiJob]::Run([string]$request.job, [string]$request.executable, [string[]]@($request.args), [string]$request.log, [string]$request.receipt.path, [string]$request.receipt.registrationId, [int]$request.receipt.attempt, [string]$request.receipt.bootId)
}
else { throw 'Unknown helper operation' }
exit 0
} catch {
  [Console]::Error.WriteLine('Windows job helper failed; no shutdown proof. Error ' + $_.Exception.HResult)
  exit 1
}
`
