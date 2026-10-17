# Registers scheduled tasks for Agent Memory Harness dreaming.
# Run:  powershell -File install-dream-task.ps1            (mechanical only, free)
#       powershell -File install-dream-task.ps1 -WithAgent (also weekly Devin session)
#
# -WithAgent runs `devin -p` with the DREAMER.md playbook once a week.
# That spends Devin usage on a schedule and runs with --permission-mode smart;
# only enable it if you're comfortable with that.

param([switch]$WithAgent)

$AmrJs   = "B:\Dev\agentmemoryrepo\cli\amr.mjs"
$Dreamer = "B:\Dev\agentmemoryrepo\dreams\DREAMER.md"
$MemRepo = Join-Path $env:USERPROFILE "agent-memory"
$Node    = (Get-Command node).Source
$Devin   = (Get-Command devin).Source

# 1. Mechanical pass — weekly, free, deterministic. Safe to always install.
schtasks /Create /TN "AgentMemoryDream-Mechanical" /SC WEEKLY /D SUN /ST 03:00 /F `
  /TR "`"$Node`" `"$AmrJs`" dream --fix"
Write-Output "installed: AgentMemoryDream-Mechanical (weekly Sun 03:00, amr dream --fix)"

# 2. Semantic pass — weekly Devin session on the local repo.
if ($WithAgent) {
  schtasks /Create /TN "AgentMemoryDream-Agent" /SC WEEKLY /D SUN /ST 04:00 /F `
    /TR "cmd /c cd /d `"$MemRepo`" && `"$Devin`" -p --permission-mode smart --prompt-file `"$Dreamer`""
  Write-Output "installed: AgentMemoryDream-Agent (weekly Sun 04:00, devin -p DREAMER.md)"
} else {
  Write-Output "skipped:   AgentMemoryDream-Agent (re-run with -WithAgent to enable)"
}

Write-Output ""
Write-Output "inspect: schtasks /Query /TN AgentMemoryDream-Mechanical"
Write-Output "remove:  schtasks /Delete /TN AgentMemoryDream-Mechanical /F"
