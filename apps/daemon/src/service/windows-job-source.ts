// Fixed source only. All runtime values arrive as JSON on stdin, never as
// PowerShell or C# source. Windows PowerShell 5.1 supplies the .NET compiler.
export const windowsJobSource = String.raw`
$ErrorActionPreference = 'Stop'
try {
$source = @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

public static class DomovoiJob {
  const uint KILL_ON_CLOSE = 0x2000;
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  // Hidden helpers have pipes but no console. Share the buffered input reader
  // so commands read ahead with the initial request are not lost.
  static readonly StreamReader Input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
  static readonly StreamWriter Output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
  public static string ReadRequest() { return Input.ReadLine(); }
  static object Field(System.Collections.Generic.Dictionary<string, object> request, string name) {
    object value;
    if (!request.TryGetValue(name, out value)) throw new InvalidOperationException("Missing helper field");
    return value;
  }
  static string Text(object value) {
    if (!(value is string)) throw new InvalidOperationException("Invalid helper string");
    return (string)value;
  }
  static uint Pid(object value) {
    // The serializer represents integer JSON numbers as Int32 or Int64.
    // Reject strings, booleans and fractional numbers instead of coercing them.
    if (!(value is int) && !(value is long)) throw new InvalidOperationException("Invalid helper PID");
    long pid = Convert.ToInt64(value);
    if (pid < 0 || pid > uint.MaxValue) throw new InvalidOperationException("Invalid helper PID");
    return (uint)pid;
  }
  public static void Serve() {
    var request = Json.DeserializeObject(ReadRequest()) as System.Collections.Generic.Dictionary<string, object>;
    if (request == null) throw new InvalidOperationException("Invalid helper request");
    string mode = Text(Field(request, "mode"));
    if (mode == "inspect") {
      var values = Field(request, "pids") as object[];
      if (values == null || values.Length < 1 || values.Length > 8) throw new InvalidOperationException("Invalid helper PIDs");
      var pids = new uint[values.Length];
      for (int i = 0; i < values.Length; ++i) pids[i] = Pid(values[i]);
      Inspect(pids);
    } else if (mode == "inspect-job") {
      InspectJob(Text(Field(request, "job")), Pid(Field(request, "pid")));
    } else if (mode == "run") {
      string job = Text(Field(request, "job")), executable = Text(Field(request, "executable")), log = Text(Field(request, "log"));
      var values = Field(request, "args") as object[];
      if (values == null) throw new InvalidOperationException("Invalid helper arguments");
      var args = new string[values.Length];
      for (int i = 0; i < values.Length; ++i) args[i] = Text(values[i]);
      object modulePath = Field(request, "psModulePath");
      string psModulePath = modulePath == null ? null : Text(modulePath);
      // Windows PowerShell rewrites this variable at startup. Restore the Node
      // supervisor's value (including absence) before the daemon inherits it.
      Environment.SetEnvironmentVariable("PSModulePath", psModulePath, EnvironmentVariableTarget.Process);
      Run(job, executable, args, log);
    } else { throw new InvalidOperationException("Unknown helper operation"); }
  }
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
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
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
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Emit(object value) { Output.WriteLine(Json.Serialize(value)); }
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
  public static void InspectJob(string name, uint pid) {
    Guid id;
    if (!name.StartsWith("Global\\Domovoi-") || !Guid.TryParse(name.Substring(15), out id)) throw new InvalidOperationException("Invalid job name");
    string boot = Boot();
    object identity = InspectProcess(pid, boot);
    IntPtr job = OpenJobObject(4, false, name); // JOB_OBJECT_QUERY, never create.
    if (job == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      if (error != 2) throw new Win32Exception(error); // Only ERROR_FILE_NOT_FOUND proves absence.
      Emit(new { bootId=boot, jobExists=false, identity=identity });
    } else {
      try { Emit(new { bootId=boot, jobExists=true, identity=identity }); }
      finally { CloseHandle(job); }
    }
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
  public static void Run(string name, string executable, string[] args, string log) {
    Guid id;
    if (!name.StartsWith("Global\\Domovoi-") || !Guid.TryParse(name.Substring(15), out id)) throw new InvalidOperationException("Invalid job name");
    string boot = Boot();
    IntPtr job = CreateJobObject(IntPtr.Zero, name);
    int createError = Marshal.GetLastWin32Error();
    if (job == IntPtr.Zero) throw new Win32Exception(createError);
    if (createError == 183) { CloseHandle(job); throw new InvalidOperationException("Job name already exists"); }
    ProcessInfo child = new ProcessInfo(); IntPtr output = IntPtr.Zero, input = IntPtr.Zero;
    IntPtr attributes = IntPtr.Zero, inherited = IntPtr.Zero;
    bool assigned = false, initialized = false;
    try {
      ExtendedLimits limits = new ExtendedLimits(); limits.Basic.Flags = KILL_ON_CLOSE;
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      ExtendedLimits actual;
      Check(QueryLimits(job, 9, out actual, (uint)Marshal.SizeOf(typeof(ExtendedLimits)), IntPtr.Zero));
      if ((actual.Basic.Flags & KILL_ON_CLOSE) == 0 || (actual.Basic.Flags & 0x1800) != 0) throw new InvalidOperationException("Job limits not confirmed");
      // Verify that the creating token can open the Global name too. The
      // LIMITED logon-task native test exercises both operations unelevated.
      IntPtr named = OpenJobObject(4, false, name);
      if (named == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      CloseHandle(named);
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
      using (Process self = Process.GetCurrentProcess()) {
        Emit(new { kind="prepared", job=name, bootId=boot.ToString(), child=Identity(child.Process, child.Pid, boot), helper=Identity(self.Handle, (uint)self.Id, boot), killOnClose=true, stdioOnly=true });
      }
      var commands = new BlockingCollection<string>();
      var reader = new Thread(() => {
        try { string line; while ((line = ReadRequest()) != null) commands.Add(line); }
        catch (System.IO.IOException) { /* Broken input also requests shutdown. */ }
        finally { commands.Add("{\"command\":\"stop\"}"); }
      }); reader.IsBackground = true; reader.Start();
      bool resumed = false, stopped = false;
      var handshake = Stopwatch.StartNew();
      while (!Ended(child.Process)) {
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
      uint code = 1;
      if (!stopped) Check(GetExitCodeProcess(child.Process, out code));
      // Always terminate the job, including after clean root exit, then read
      // accounting through the same retained handle. A root exit proves less.
      Check(TerminateJobObject(job, 1));
      var stopping = Stopwatch.StartNew();
      while (Active(job) != 0) {
        if (stopping.ElapsedMilliseconds > 10000) throw new InvalidOperationException("Job remains nonempty");
        Thread.Sleep(25);
      }
      Emit(new { kind="empty", job=name, bootId=boot.ToString(), activeProcesses=0, terminated=true, code=code, stopped=stopped });
    } finally {
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
$parameters = [System.CodeDom.Compiler.CompilerParameters]::new()
$parameters.ReferencedAssemblies.AddRange([string[]]@('System.dll', 'System.Core.dll', 'System.Web.Extensions.dll'))
$parameters.GenerateInMemory = $true
$provider = [Microsoft.CSharp.CSharpCodeProvider]::new()
try {
  $compiled = $provider.CompileAssemblyFromSource($parameters, [string[]]@($source))
  if ($compiled.Errors.HasErrors) { throw 'Windows job helper compilation failed' }
  $null = $compiled.CompiledAssembly
} finally {
  $provider.Dispose()
}
[DomovoiJob]::Serve()
exit 0
} catch {
  [Console]::Error.WriteLine('Windows job helper failed; no shutdown proof. Error ' + $_.Exception.HResult)
  exit 1
}
`
