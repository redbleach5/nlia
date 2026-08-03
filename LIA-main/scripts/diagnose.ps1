# ============================================================================
# Lia v2 — Полная диагностика системы (Windows / PowerShell)
# ============================================================================
#
# Запуск в PowerShell:
#   cd Lia-v2
#   .\scripts\diagnose.ps1
#
# Или с детализацией:
#   .\scripts\diagnose.ps1 -Verbose
#
# Если скрипт не запускается из-за Execution Policy:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\scripts\diagnose.ps1
#
# Лог сохраняется в: diagnose-YYYYMMDD-HHMMSS.log
#
# Скрипт проверяет:
#   1. Окружение: node, bun, ollama, python, git, curl
#   2. GPU: NVIDIA карта, драйвер, VRAM
#   3. Ollama: health, доступные модели, время отклика
#   4. LLM генерация: тестовый промпт, токены/сек
#   5. Embedding: размерность, скорость
#   6. БД: Prisma подключение, sqlite-vec extension
#   7. Проект: билд, dev-сервер, ключевые endpoints
#   8. Chat API: стриминг, время ответа
#   9. Agent API: создание, выполнение, SSE
#  10. VRM: наличие файла, доступность по URL
#  11. Финальный отчёт с рекомендациями
#
# Скрипт НЕ вносит изменения в систему — только чтение и тесты.

[CmdletBinding()]
param(
    [switch]$Verbose
)

$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

# ============================================================================
# Конфигурация
# ============================================================================
$ProjectRoot = Resolve-Path "$PSScriptRoot\.."
Set-Location $ProjectRoot

$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogFile = "$ProjectRoot\diagnose-$Timestamp.log"
$DevLogFile = "$ProjectRoot\diagnose-dev.log"

# Счётчики
$script:PassCount = 0
$script:FailCount = 0
$script:WarnCount = 0
$script:SkipCount = 0

# ============================================================================
# Helpers
# ============================================================================
function Log {
    param([string]$Message)
    Write-Host $Message
    Add-Content -Path $LogFile -Value $Message
}

function Section {
    param([string]$Title)
    Log ""
    Log "==============================================================="
    Log "  $Title"
    Log "==============================================================="
}

function Pass {
    param([string]$Msg, [string]$Detail = "")
    $script:PassCount++
    if ($Detail) {
        Log "  [PASS] $Msg  ($Detail)"
    } else {
        Log "  [PASS] $Msg"
    }
}

function Fail {
    param([string]$Msg, [string]$Detail = "")
    $script:FailCount++
    Log "  [FAIL] $Msg"
    if ($Detail) {
        Log "         $Detail"
    }
}

function Warn {
    param([string]$Msg, [string]$Detail = "")
    $script:WarnCount++
    Log "  [WARN] $Msg"
    if ($Detail) {
        Log "         $Detail"
    }
}

function Info {
    param([string]$Msg)
    Log "  [INFO] $Msg"
}

function Skip {
    param([string]$Msg)
    $script:SkipCount++
    Log "  [SKIP] $Msg"
}

function VerboseLog {
    param([string]$Msg)
    if ($Verbose) {
        Log "  [DBG]  $Msg"
    }
}

# Замер времени команды
function Invoke-WithTiming {
    param([scriptblock]$ScriptBlock)
    $start = Get-Date
    $output = & $ScriptBlock 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) { $exitCode = 0 }
    $end = Get-Date
    $durationMs = [int]($end - $start).TotalMilliseconds
    return @{
        DurationMs = $durationMs
        ExitCode = $exitCode
        Output = $output
    }
}

# ============================================================================
# Старт
# ============================================================================
Log "Lia v2 — полная диагностика системы (Windows)"
Log "Время: $(Get-Date)"
Log "Платформа: $($PSVersionTable.OS) PowerShell $($PSVersionTable.PSVersion)"
Log "Лог: $LogFile"
Log "Verbose: $Verbose"
Log ""

# ============================================================================
# 1. Окружение
# ============================================================================
Section "1. Окружение"

# Node
$nodeVersion = (node --version 2>&1) | Out-String
if ($LASTEXITCODE -eq 0) {
    Pass "Node.js: $($nodeVersion.Trim())"
} else {
    Fail "Node.js не найден" "Установи: https://nodejs.org/"
}

# Bun
$bunVersion = (bun --version 2>&1) | Out-String
if ($LASTEXITCODE -eq 0) {
    Pass "Bun: $($bunVersion.Trim())"
} else {
    Warn "Bun не найден" "Можно использовать npm/yarn, но рекомендуется bun (https://bun.sh)"
}

# Python
$pyVersion = (python --version 2>&1) | Out-String
if ($LASTEXITCODE -eq 0) {
    Pass "Python: $($pyVersion.Trim())"
} else {
    $pyVersion = (python3 --version 2>&1) | Out-String
    if ($LASTEXITCODE -eq 0) {
        Pass "Python: $($pyVersion.Trim())"
    } else {
        Warn "Python не найден" "Нужен для RL sidecar (опционально)"
    }
}

# Git
$gitVersion = (git --version 2>&1) | Out-String
if ($LASTEXITCODE -eq 0) {
    Pass "Git: $($gitVersion.Trim())"
} else {
    Fail "Git не найден" "Установи Git for Windows: https://git-scm.com/"
}

# Curl
$curlVersion = (curl --version 2>&1 | Select-Object -First 1) | Out-String
if ($LASTEXITCODE -eq 0) {
    Pass "curl: $($curlVersion.Trim())"
} else {
    Fail "curl не найден" "В Windows 10+ встроен."
}

# Ollama
$ollamaVersionOutput = (ollama --version 2>&1) | Out-String
if ($LASTEXITCODE -eq 0) {
    if ($ollamaVersionOutput -match "could not connect|warning") {
        Warn "Ollama CLI установлен, но сервис не запущен" "Запусти Ollama из Start Menu или 'ollama serve'"
        Info "Вывод: $($ollamaVersionOutput.Split("`n")[0])"
    } else {
        Pass "Ollama CLI: $($ollamaVersionOutput.Split("`n")[0].Trim())"
    }
} else {
    Warn "Ollama CLI не в PATH" "Установи: https://ollama.com/download/windows"
    $ollamaPaths = @(
        "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
        "$env:ProgramFiles\Ollama\ollama.exe",
        "${env:ProgramFiles(x86)}\Ollama\ollama.exe"
    )
    foreach ($p in $ollamaPaths) {
        if (Test-Path $p) {
            Info "Ollama найден в: $p"
            break
        }
    }
}

# ============================================================================
# 2. GPU (NVIDIA)
# ============================================================================
Section "2. GPU (NVIDIA)"

$nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($nvidiaSmi) {
    $gpuInfo = (nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>&1) | Out-String
    if ($gpuInfo -and $gpuInfo -notmatch "not found|fail") {
        Pass "NVIDIA GPU: $($gpuInfo.Trim())"

        if ($gpuInfo -match "(\d+)\s*MiB") {
            $vramMb = [int]$Matches[1]
            $vramGb = [math]::Round($vramMb / 1024, 1)
            Info "VRAM: ${vramGb}GB ($($vramMb)MiB)"

            if ($vramGb -ge 12) {
                Pass "VRAM ${vramGb}GB — достаточно для 7B-13B моделей"
            } elseif ($vramGb -ge 8) {
                Pass "VRAM ${vramGb}GB — достаточно для 7B моделей"
            } elseif ($vramGb -ge 4) {
                Warn "VRAM ${vramGb}GB — мало для 7B, используй 3B модели" "qwen2.5:3b или phi3:mini"
            } else {
                Fail "VRAM ${vramGb}GB — критически мало" "LLM будет идти на CPU"
            }
        }

        # Проверка занятости GPU
        $gpuProcesses = (nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader 2>&1) | Out-String
        if ($gpuProcesses -and $gpuProcesses.Trim() -and $gpuProcesses -notmatch "not found") {
            Warn "GPU занят другими процессами" "Это может снизить скорость LLM:"
            $gpuProcesses.Trim().Split("`n") | ForEach-Object { Log "         $_" }
        } else {
            Pass "GPU свободен"
        }
    } else {
        Fail "nvidia-smi не вернул данные" "Проверь драйвер NVIDIA"
    }
} else {
    Fail "nvidia-smi не найден в PATH" "Установи драйвер NVIDIA: https://www.nvidia.com/Download/index.aspx"
}

# CUDA
$nvcc = Get-Command nvcc -ErrorAction SilentlyContinue
if ($nvcc) {
    $cudaVersion = (nvcc --version 2>&1 | Select-String "release" | Select-Object -First 1) -replace ".*release (\S+).*", '$1'
    Pass "CUDA toolkit: $cudaVersion"
} else {
    Info "CUDA toolkit не найден (не обязательно — Ollama использует встроенный)"
}

# ============================================================================
# 3. Ollama
# ============================================================================
Section "3. Ollama"

# Читаем .env
$envContent = Get-Content "$ProjectRoot\.env" -ErrorAction SilentlyContinue
$ollamaBaseUrl = "http://127.0.0.1:11434"
foreach ($line in $envContent) {
    if ($line -match "^OLLAMA_BASE_URL=(.+)$") {
        $ollamaBaseUrl = $Matches[1].Trim()
        break
    }
}
Info "Base URL: $ollamaBaseUrl"

# Проверка доступности
$result = Invoke-WithTiming { curl -s -m 5 "$ollamaBaseUrl/api/tags" }
if ($result.ExitCode -eq 0 -and $result.Output -match '"models"') {
    try {
        $data = $result.Output | ConvertFrom-Json
        $modelsCount = $data.models.Count
        Pass "Ollama доступен ($($result.DurationMs) ms, моделей: $modelsCount)"

        Info "Доступные модели:"
        foreach ($m in $data.models) {
            $sizeMb = [math]::Round($m.size / 1MB, 0)
            Log "         $($m.name) ($($sizeMb)MB)"
        }
    } catch {
        Fail "Ollama ответил, но не парсится JSON" $_
        $script:SkipOllama = $true
    }
} else {
    Fail "Ollama недоступен на $ollamaBaseUrl" "Запусти Ollama из Start Menu или 'ollama serve'"
    $script:SkipOllama = $true
}

if (-not $script:SkipOllama) {
    # Chat-модель
    $chatModel = ""
    foreach ($line in $envContent) {
        if ($line -match "^OLLAMA_MODEL=(.+)$") {
            $chatModel = $Matches[1].Trim()
            break
        }
    }
    if (-not $chatModel) { $chatModel = "qwen2.5:7b" }
    Info "Chat-модель (из .env): $chatModel"

    $modelExists = $false
    foreach ($m in $data.models) {
        if ($m.name -eq $chatModel) { $modelExists = $true; break }
    }
    if ($modelExists) {
        Pass "Chat-модель '$chatModel' доступна"
    } else {
        $partialMatch = $false
        $chatModelPrefix = $chatModel.Split(":")[0]
        foreach ($m in $data.models) {
            if ($m.name -like "$chatModelPrefix*") { $partialMatch = $true; break }
        }
        if ($partialMatch) {
            Warn "Chat-модель '$chatModel' не точное совпадение" "Lia будет использовать partial match"
        } else {
            Fail "Chat-модель '$chatModel' не найдена" "Скачай: ollama pull $chatModel"
        }
    }

    # Embed-модель
    $embedModel = ""
    foreach ($line in $envContent) {
        if ($line -match "^OLLAMA_EMBED_MODEL=(.+)$") {
            $embedModel = $Matches[1].Trim()
            break
        }
    }
    if (-not $embedModel) { $embedModel = "nomic-embed-text" }
    Info "Embed-модель (из .env): $embedModel"

    $embedExists = $false
    foreach ($m in $data.models) {
        if ($m.name -eq $embedModel) { $embedExists = $true; break }
    }
    if ($embedExists) {
        Pass "Embed-модель '$embedModel' доступна"
    } else {
        Fail "Embed-модель '$embedModel' не найдена" "Скачай: ollama pull $embedModel"
    }
} else {
    Skip "Все остальные тесты Ollama пропущены"
}

# ============================================================================
# 4. Тест генерации LLM
# ============================================================================
if (-not $script:SkipOllama) {
    Section "4. Тест генерации LLM"

    Info "Тестовый промпт: 'Назови столицу Франции. Одно слово.'"

    $body = @{
        model = $chatModel
        prompt = "Назови столицу Франции. Одно слово."
        stream = $false
    } | ConvertTo-Json -Compress

    $result = Invoke-WithTiming { curl -s -m 180 "$ollamaBaseUrl/api/generate" -H "Content-Type: application/json" -d $body }

    if ($result.ExitCode -eq 0 -and $result.Output) {
        try {
            $data = $result.Output | ConvertFrom-Json
            if ($data.response) {
                $response = $data.response.Substring(0, [math]::Min(200, $data.response.Length))
                $evalCount = $data.eval_count
                $evalDuration = if ($data.eval_duration) { $data.eval_duration / 1e9 } else { 0 }

                Pass "LLM ответила ($($result.DurationMs) ms, $evalCount токенов)"
                Info "Ответ: $response"

                if ($evalDuration -gt 0 -and $evalCount -gt 0) {
                    $tokensPerSec = [math]::Round($evalCount / $evalDuration, 1)
                    Info "Скорость: $tokensPerSec токенов/сек"

                    if ($tokensPerSec -gt 15) {
                        Pass "Скорость отличная (>15 tok/s) — GPU работает"
                    } elseif ($tokensPerSec -gt 5) {
                        Pass "Скорость приемлемая ($tokensPerSec tok/s)"
                    } elseif ($tokensPerSec -gt 1) {
                        Warn "Скорость низкая ($tokensPerSec tok/s)" "Возможно CPU. Проверь ollama ps"
                    } else {
                        Fail "Скорость критически низкая ($tokensPerSec tok/s)" "LLM явно на CPU"
                    }
                }
            } else {
                Fail "LLM вернул пустой ответ" $result.Output
            }
        } catch {
            Fail "LLM ответ не парсится" $_
        }
    } else {
        Fail "LLM не ответил за 180 секунд" "Модель большая или GPU недоступен"
    }

    # Проверка GPU использования
    Info "Проверяю использование GPU через 'ollama ps'..."
    $ollamaPs = (ollama ps 2>&1) | Out-String
    if ($ollamaPs) {
        Log "         $($ollamaPs.Trim() -replace "`n", "`n         `")"
        if ($ollamaPs -match "CPU" -and $ollamaPs -notmatch "GPU") {
            Warn "Ollama использует CPU!" "Проверь драйвер NVIDIA. Должно быть GPU."
        } elseif ($ollamaPs -match "GPU") {
            Pass "Ollama использует GPU"
        }
    }
}

# ============================================================================
# 5. Тест embedding
# ============================================================================
if (-not $script:SkipOllama) {
    Section "5. Тест embedding"

    Info "Тестовый текст: 'Привет, как дела?'"

    $body = @{
        model = $embedModel
        input = "Привет, как дела?"
    } | ConvertTo-Json -Compress

    $result = Invoke-WithTiming { curl -s -m 60 "$ollamaBaseUrl/api/embed" -H "Content-Type: application/json" -d $body }

    if ($result.ExitCode -eq 0 -and $result.Output) {
        try {
            $data = $result.Output | ConvertFrom-Json
            $vec = if ($data.embeddings) { $data.embeddings[0] } else { $data.embedding }
            if ($vec -and $vec.Count -gt 0) {
                $dims = $vec.Count
                Pass "Embedding работает ($($result.DurationMs) ms, размерность: $dims)"

                if ($result.DurationMs -gt 10000) {
                    Warn "Embedding очень медленный ($($result.DurationMs) ms)" "Возможно CPU"
                } elseif ($result.DurationMs -gt 3000) {
                    Info "Embedding медленный ($($result.DurationMs) ms) — норма для CPU"
                }
            } else {
                Fail "Embedding вернул пустой вектор"
            }
        } catch {
            Fail "Embedding ответ не парсится" $_
        }
    } else {
        Fail "Embedding не ответил за 60 секунд"
    }
}

# ============================================================================
# 6. Проект и БД
# ============================================================================
Section "6. Проект и БД"

if (Test-Path "$ProjectRoot\.env") {
    Pass ".env найден"

    $envChatModel = ""
    $envBaseUrl = ""
    foreach ($line in $envContent) {
        if ($line -match "^OLLAMA_MODEL=(.*)$") { $envChatModel = $Matches[1].Trim() }
        if ($line -match "^OLLAMA_BASE_URL=(.*)$") { $envBaseUrl = $Matches[1].Trim() }
    }
    if (-not $envChatModel) {
        Warn "OLLAMA_MODEL пустой в .env" "Задай явно, например OLLAMA_MODEL=qwen2.5:7b"
    }
    if (-not $envBaseUrl) {
        Warn "OLLAMA_BASE_URL пустой в .env" "Default: http://127.0.0.1:11434"
    }
} else {
    Fail ".env не найден" "Скопируй: copy .env.example .env"
}

if (Test-Path "$ProjectRoot\node_modules") {
    Pass "node_modules установлен"
} else {
    Fail "node_modules не найден" "Запусти: bun install (или npm install)"
}

if (Test-Path "$ProjectRoot\node_modules\@prisma") {
    Pass "Prisma установлен"
    if (Test-Path "$ProjectRoot\node_modules\@prisma\client\index.js") {
        Pass "Prisma client сгенерирован"
    } else {
        Warn "Prisma client не сгенерирован" "Запусти: bunx prisma generate"
    }
} else {
    Fail "Prisma не установлен"
}

# Read DATABASE_URL from .env (mirror of src/lib/paths.ts logic)
$dbUrlRaw = $null
if (Test-Path "$ProjectRoot\.env") {
    $match = Select-String -Path "$ProjectRoot\.env" -Pattern '^DATABASE_URL=(.+)$' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($match) { $dbUrlRaw = $match.Matches[0].Groups[1].Value.Trim() }
}
if (-not $dbUrlRaw) { $dbUrlRaw = 'file:../db/custom.db' }
$dbRelPath = $dbUrlRaw -replace '^file:', ''
# Strip leading ../ or ..\ (src/lib/paths.ts does the same)
while ($dbRelPath -match '^\.\.[\\/]') { $dbRelPath = $dbRelPath.Substring(3) }

$dbPath = Join-Path $ProjectRoot $dbRelPath
$dbPath = [System.IO.Path]::GetFullPath($dbPath)
if (Test-Path $dbPath) {
    $dbSize = (Get-Item $dbPath).Length / 1KB
    Pass "БД существует ($([math]::Round($dbSize, 1))KB)"
} else {
    Warn "БД не существует" "Запусти: bun run db:push"
}

# ── DB path consistency check (audit §2.1) ──
Info "Проверяю согласованность пути к БД (Prisma vs better-sqlite3)..."
$prismaDbPath = Join-Path (Join-Path $ProjectRoot 'prisma') ($dbUrlRaw -replace '^file:', '')
$prismaDbPath = [System.IO.Path]::GetFullPath($prismaDbPath)
if ($prismaDbPath -eq $dbPath) {
    Pass "Путь к БД согласован: $dbPath"
} else {
    Fail "Расхождение путей БД (критично!)" `
        "Prisma открывает: $prismaDbPath
         better-sqlite3 открывает: $dbPath
         Используй DATABASE_URL=file:../db/custom.db в .env, затем удали обе базы и запусти bun run db:push."
}

# ── DB schema completeness check ──
# KB tables (Source/Chunk/Ticket) are optional: they were added in KB Phase 1
# and may not exist on older databases. We list them separately and only warn
# (not fail) if missing — `bun run db:push` will create them.
if (Test-Path $dbPath) {
    Info "Проверяю наличие всех таблиц Prisma в БД..."
    $requiredTables = @('Episode','Message','GlobalFact','EpisodeFact','VectorMemory','EmotionalMemory','AgentTask','RlModelVersion','RLExperience','Setting')
    $kbTables = @('Source','Chunk')
    $missing = @()
    $missingKb = @()
    foreach ($tbl in $requiredTables) {
        $checkScript = @"
const Database = require('better-sqlite3');
const db = new Database('$($dbPath -replace '\','/')', { readonly: true });
const row = db.prepare(`"SELECT name FROM sqlite_master WHERE type='table' AND name = ?`").get('$tbl');
db.close();
process.exit(row ? 0 : 1);
"@
        $env:NODE_PATH = "$ProjectRoot
ode_modules"
        & node -e $checkScript 2>$null
        if ($LASTEXITCODE -ne 0) { $missing += $tbl }
    }
    foreach ($tbl in $kbTables) {
        $checkScript = @"
const Database = require('better-sqlite3');
const db = new Database('$($dbPath -replace '\','/')', { readonly: true });
const row = db.prepare(`"SELECT name FROM sqlite_master WHERE type='table' AND name = ?`").get('$tbl');
db.close();
process.exit(row ? 0 : 1);
"@
        $env:NODE_PATH = "$ProjectRoot
ode_modules"
        & node -e $checkScript 2>$null
        if ($LASTEXITCODE -ne 0) { $missingKb += $tbl }
    }
    if ($missing.Count -eq 0) {
        Pass "Все 10 базовых таблиц Prisma присутствуют в БД"
    } else {
        Fail "В БД отсутствуют таблицы: $($missing -join ' ')" `
            "Возможно БД создана лучше-sqlite3 без Prisma schema. Удали $dbPath и запусти bun run db:push."
    }
    if ($missingKb.Count -eq 0) {
        Pass "KB таблицы Source и Chunk присутствуют"
    } else {
        Warn "В БД отсутствуют KB таблицы: $($missingKb -join ' ')" `
            "Knowledge Base не будет работать до запуска bun run db:push (KB Phase 1+)."
    }
}

$sqliteVecDir = Get-ChildItem "$ProjectRoot\node_modules" -Directory -Filter "sqlite-vec-*" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($sqliteVecDir) {
    Pass "sqlite-vec пакет: $($sqliteVecDir.Name)"
    $nativeBin = Get-ChildItem $sqliteVecDir.FullName -Filter "vec0.*" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nativeBin) {
        Pass "sqlite-vec native binary: $($nativeBin.Name)"
    } else {
        Fail "sqlite-vec native binary не найден" "Переустанови: Remove-Item -r node_modules; bun install"
    }
} else {
    Fail "sqlite-vec пакет не установлен"
}

Set-Location $ProjectRoot
$gitBranch = (git rev-parse --abbrev-ref HEAD 2>&1) | Out-String
$gitCommit = (git rev-parse --short HEAD 2>&1) | Out-String
if ($LASTEXITCODE -eq 0) {
    Pass "Git: ветка $($gitBranch.Trim()), коммит $($gitCommit.Trim())"

    $gitStatus = (git status --porcelain 2>&1) | Out-String
    if ($gitStatus.Trim()) {
        $changes = ($gitStatus.Trim().Split("`n")).Count
        Warn "Есть несохранённые изменения ($changes файлов)"
    }
}

Info "Проверяю права на запись..."
foreach ($dir in @("db", "download", "public\models")) {
    $fullPath = "$ProjectRoot\$dir"
    if (Test-Path $fullPath) {
        Pass "Папка $dir существует"
    } else {
        try {
            New-Item -Path $fullPath -ItemType Directory -Force | Out-Null
            Pass "Папка $dir создана"
        } catch {
            Fail "Не могу создать папку $dir" $_
        }
    }
}

$drive = Get-PSDrive -Name (Split-Path $ProjectRoot -Qualifier).Replace(":", "") -ErrorAction SilentlyContinue
if ($drive) {
    $freeGb = [math]::Round($drive.Free / 1GB, 1)
    Info "Свободное место: ${freeGb}GB"
    if ($freeGb -lt 1) {
        Warn "Мало места (${freeGb}GB)"
    }
}

$port3000 = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($port3000) {
    Warn "Порт 3000 занят (PID: $($port3000.OwningProcess))" "Заверши: Stop-Process -Id $($port3000.OwningProcess) -Force"
} else {
    Pass "Порт 3000 свободен"
}

# ============================================================================
# 7. Сборка проекта
# ============================================================================
Section "7. Сборка проекта"

if (Test-Path "$ProjectRoot\.next") {
    Info "Очищаю кэш .next для чистой сборки..."
    Remove-Item -Recurse -Force "$ProjectRoot\.next"
}

Info "Запускаю 'bun run build' (1-2 минуты)..."

$result = Invoke-WithTiming { bun run build 2>&1 }
$durationSec = [math]::Round($result.DurationMs / 1000, 0)

if ($result.ExitCode -eq 0) {
    Pass "Сборка успешна (${durationSec}s)"
} else {
    Fail "Сборка провалилась" "Последние строки:"
    $result.Output.Split("`n") | Select-Object -Last 20 | ForEach-Object {
        Log "         $_"
    }
}

# ============================================================================
# 8. Dev-сервер и API
# ============================================================================
Section "8. Dev-сервер и API"

Info "Запускаю dev-сервер в фоне..."

if ($port3000) {
    Stop-Process -Id $port3000.OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

if (Test-Path $DevLogFile) { Remove-Item $DevLogFile }
if (Test-Path "$DevLogFile.err") { Remove-Item "$DevLogFile.err" }

$devProcess = Start-Process -FilePath "bun" -ArgumentList "run", "dev" -RedirectStandardOutput $DevLogFile -RedirectStandardError "$DevLogFile.err" -PassThru -WindowStyle Hidden

Info "Жду запуска (до 60 секунд)..."
$devReady = $false
for ($i = 1; $i -le 60; $i++) {
    Start-Sleep -Seconds 1
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:3000/api/health" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        if ($response.StatusCode -eq 200) {
            $devReady = $true
            Info "Dev-сервер готов после ${i}s"
            break
        }
    } catch {}
}

if (-not $devReady) {
    Fail "Dev-сервер не запустился за 60 секунд"
    if (Test-Path $DevLogFile) {
        Info "Последние 30 строк dev-лога:"
        Get-Content $DevLogFile -Tail 30 | ForEach-Object { Log "         $_" }
    }
    $script:SkipApi = $true
} else {
    Pass "Dev-сервер запущен на порту 3000"

    $result = Invoke-WithTiming { curl -s -m 5 "http://localhost:3000/api/health" }
    if ($result.ExitCode -eq 0) {
        try {
            $data = $result.Output | ConvertFrom-Json
            if ($data.ok) {
                Pass "/api/health: Ollama OK ($($result.DurationMs) ms)"
            } else {
                Warn "/api/health: Ollama недоступен через сервер"
            }
        } catch {
            Warn "/api/health: ответ не парсится"
        }
    }

    $result = Invoke-WithTiming { curl -s -m 5 "http://localhost:3000/api/settings" }
    if ($result.ExitCode -eq 0) {
        Pass "/api/settings отвечает ($($result.DurationMs) ms)"
    }

    $result = Invoke-WithTiming { curl -s -m 5 "http://localhost:3000/api/episodes" }
    if ($result.ExitCode -eq 0) {
        Pass "/api/episodes отвечает ($($result.DurationMs) ms)"
    }
}

# ============================================================================
# 9. Chat API
# ============================================================================
if (-not $script:SkipApi -and -not $script:SkipOllama) {
    Section "9. Chat API"

    Info "Создаю тестовый эпизод..."
    $result = curl -s -m 5 -X POST "http://localhost:3000/api/episodes" -H "Content-Type: application/json" -d '{"title":"diagnose-test"}'
    try {
        $episodeId = ($result | ConvertFrom-Json).episode.id
        if ($episodeId) {
            Pass "Тестовый эпизод создан: $episodeId"
        } else {
            Fail "Не удалось создать эпизод" $result
            $script:SkipChat = $true
        }
    } catch {
        Fail "Не удалось создать эпизод" $_
        $script:SkipChat = $true
    }

    if (-not $script:SkipChat) {
        Info "Отправляю: 'Привет! Как дела?'"

        $body = @{
            text = "Привет! Как дела?"
            episodeId = $episodeId
            mode = "fast"
        } | ConvertTo-Json -Compress

        $result = Invoke-WithTiming { curl -s -m 180 -X POST "http://localhost:3000/api/chat" -H "Content-Type: application/json" -d $body }

        if ($result.Output) {
            $responseLen = $result.Output.Length
            $durationSec = [math]::Round($result.DurationMs / 1000, 1)
            Pass "Chat ответил за ${durationSec}s ($responseLen символов)"
            Info "Ответ: $($result.Output.Substring(0, [math]::Min(200, $responseLen)))"

            if ($result.DurationMs -gt 60000) {
                Warn "Chat отвечал долго ($durationSec сек)" "Увеличь LIA_LLM_TIMEOUT_MS"
            }
            if ($responseLen -lt 10) {
                Warn "Ответ очень короткий ($responseLen символов)"
            }
        } else {
            Fail "Chat не ответил"
        }
    }
}

# ============================================================================
# 10. Agent API
# ============================================================================
if (-not $script:SkipApi -and -not $script:SkipChat -and $episodeId) {
    Section "10. Agent API"

    Info "Создаю агентскую задачу..."

    $body = @{
        episodeId = $episodeId
        goal = "Напиши hello world на Python"
        autoStart = $true
        maxSteps = 3
    } | ConvertTo-Json -Compress

    $result = curl -s -m 10 -X POST "http://localhost:3000/api/agent" -H "Content-Type: application/json" -d $body
    try {
        $taskId = ($result | ConvertFrom-Json).task.id
        if ($taskId) {
            Pass "Агентская задача создана: $taskId"

            Info "Жду 30 секунд..."
            Start-Sleep -Seconds 30

            $result = curl -s -m 5 "http://localhost:3000/api/agent/$taskId"
            $taskData = ($result | ConvertFrom-Json).task
            $taskStatus = $taskData.status

            Info "Статус: $taskStatus"

            switch ($taskStatus) {
                "done" {
                    Pass "Агент завершил задачу"
                    if ($taskData.resultSummary) {
                        $prev = $taskData.resultSummary.Substring(0, [math]::Min(200, $taskData.resultSummary.Length))
                        Info "Результат: $prev"
                    }
                }
                "failed" {
                    Fail "Агент провалился" $taskData.error
                }
                { $_ -in @("planning", "executing", "synthesizing") } {
                    Warn "Агент ещё работает ($taskStatus)" "Жду ещё 30с..."
                    Start-Sleep -Seconds 30
                    $result = curl -s -m 5 "http://localhost:3000/api/agent/$taskId"
                    $taskData = ($result | ConvertFrom-Json).task
                    Info "Статус: $($taskData.status)"
                    if ($taskData.status -eq "done") {
                        Pass "Агент завершил (после ожидания)"
                    } elseif ($taskData.status -eq "failed") {
                        Fail "Агент провалился" $taskData.error
                    } else {
                        Warn "Агент всё ещё работает" "Нужны большие таймауты или быстрая модель"
                    }
                }
                "waiting_input" {
                    Warn "Агент ждёт ответа"
                    curl -s -m 5 -X POST "http://localhost:3000/api/agent/$taskId/cancel" | Out-Null
                }
                default {
                    Warn "Неизвестный статус: $taskStatus"
                }
            }
        } else {
            Fail "Не удалось создать задачу" $result
        }
    } catch {
        Fail "Не удалось создать задачу" $_
    }
}

# ============================================================================
# 11. VRM аватар
# ============================================================================
Section "11. VRM аватар"

$vrmDir = "$ProjectRoot\public\models"
if (Test-Path $vrmDir) {
    $vrmFiles = Get-ChildItem $vrmDir -Filter "*.vrm" -ErrorAction SilentlyContinue
    if ($vrmFiles) {
        foreach ($vrm in $vrmFiles) {
            $sizeMb = [math]::Round($vrm.Length / 1MB, 1)
            Pass "VRM файл: $($vrm.Name) ($($sizeMb)MB)"
        }
    } else {
        Warn "VRM файлы не найдены в public\models" "Скачай через Настройки → Внешний вид"
    }
} else {
    Warn "Папка public\models не существует"
}

if (-not $script:SkipApi) {
    $result = curl -s -m 5 "http://localhost:3000/api/settings"
    try {
        $data = $result | ConvertFrom-Json
        Info "Avatar mode: $($data.avatarMode)"
        if ($data.activeVrm) {
            Info "Active VRM: $($data.activeVrm)"
            try {
                $vrmResponse = Invoke-WebRequest -Uri "http://localhost:3000$($data.activeVrm)" -TimeoutSec 5 -UseBasicParsing -Method Head
                if ($vrmResponse.StatusCode -eq 200) {
                    Pass "VRM файл доступен по URL"
                }
            } catch {
                Fail "VRM файл недоступен" $_
            }
        } else {
            Warn "VRM не выбран" "Колонка аватара покажет placeholder без модели"
        }
    } catch {}
}

# ============================================================================
# 12. Очистка
# ============================================================================
if (-not $script:SkipApi -and $episodeId) {
    Section "12. Очистка"
    Info "Удаляю тестовый эпизод..."
    curl -s -m 5 -X DELETE "http://localhost:3000/api/episodes/$episodeId" | Out-Null
    Pass "Тестовый эпизод удалён"
}

if ($devProcess -and -not $devProcess.HasExited) {
    Info "Останавливаю dev-сервер..."
    Stop-Process -Id $devProcess.Id -Force -ErrorAction SilentlyContinue
    Get-Process -Name "next-server" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Pass "Dev-сервер остановлен"

    if (Test-Path $DevLogFile) {
        Info "Анализирую dev-лог..."
        $devLogContent = Get-Content $DevLogFile -Raw
        $errorsCount = ($devLogContent | Select-String -Pattern "Error|ERROR|Failed|FAIL" -AllMatches).Matches.Count
        $errorsCount -= ($devLogContent | Select-String -Pattern "terminated by signal|Bail out" -AllMatches).Matches.Count
        $warningsCount = ($devLogContent | Select-String -Pattern "WARN" -AllMatches).Matches.Count

        Info "Dev-лог: $errorsCount ошибок, $warningsCount предупреждений"

        if ($errorsCount -gt 0) {
            Warn "В dev-логе есть ошибки ($errorsCount)"
            $devLogContent -split "`n" | Where-Object { $_ -match "Error|ERROR|Failed|FAIL" -and $_ -notmatch "terminated|Bail out" } | Select-Object -Last 10 | ForEach-Object {
                Log "         $_"
            }
        }

        Info "Последние 5 строк dev-лога:"
        Get-Content $DevLogFile -Tail 5 | ForEach-Object { Log "         $_" }
    }
}

# ============================================================================
# Финальный отчёт
# ============================================================================
Section "Финальный отчёт"

Log "Системная информация:"
Log "  Платформа: $($PSVersionTable.OS)"
Log "  PowerShell: $($PSVersionTable.PSVersion)"
Log "  Время: $(Get-Date)"

if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    $gpuName = (nvidia-smi --query-gpu=name --format=csv,noheader 2>&1).Trim()
    $gpuVram = (nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>&1).Trim()
    Log "  GPU: $gpuName (VRAM: $gpuVram)"
}

$os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
if ($os) {
    $totalRamGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    Log "  RAM: ${totalRamGb}GB"
}
Log ""

Log "Результаты:"
Log "  Прошло:     $script:PassCount"
Log "  Провалено:  $script:FailCount"
Log "  Предупреждений: $script:WarnCount"
Log "  Пропущено:  $script:SkipCount"
Log ""

if ($script:FailCount -gt 0) {
    Log "[FAIL] Есть критические проблемы"
    Log ""
    Log "Частые проблемы и решения (Windows):"
    Log ""
    Log "  Если Ollama недоступен:"
    Log "    1. Открой Ollama из Start Menu (Пуск → Ollama)"
    Log "    2. Или запусти в PowerShell: ollama serve"
    Log "    3. Проверь что Ollama появилась в системном трее"
    Log "    4. После запуска — перезапусти этот скрипт"
    Log ""
    Log "  Если OLLAMA_MODEL пустой в .env:"
    Log "    1. notepad .env"
    Log "    2. OLLAMA_MODEL=qwen2.5:7b  (для 12GB VRAM)"
    Log "    3. ollama pull qwen2.5:7b"
    Log ""
    Log "  Если GPU не используется (LLM медленный):"
    Log "    1. nvidia-smi  (проверь драйвер)"
    Log "    2. ollama ps   (проверь что GPU, не CPU)"
    Log "    3. Если CPU — переустанови Ollama: https://ollama.com/download/windows"
    Log "    4. Перезагрузи ПК после установки драйвера"
    Log ""
    Log "  Если chat/agent таймаутит:"
    Log "    1. ollama run qwen2.5:7b 'hello'  (проверь скорость)"
    Log "    2. Если <10 tok/s — GPU не используется"
    Log "    3. Увеличь LIA_LLM_TIMEOUT_MS в .env (по умолчанию 180000)"
    Log "    4. LOG_LEVEL=debug для детальных логов"
    Log ""
    Log "  Если порт 3000 занят:"
    Log "    1. netstat -ano | findstr :3000"
    Log "    2. taskkill /PID <PID> /F"
    Log ""
    Log "  Если Execution Policy блокирует скрипт:"
    Log "    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass"
    Log ""
    Log "Что прислать для диагностики:"
    Log "  1. Лог: $LogFile"
    Log "  2. Dev-лог: $DevLogFile (если существует)"
    Log "  3. ollama list"
    Log "  4. nvidia-smi"
    Log ""
} elseif ($script:WarnCount -gt 0) {
    Log "[WARN] Есть предупреждения, критических проблем нет"
    Log ""
} else {
    Log "[PASS] Все проверки успешны!"
    Log ""
    Log "Lia v2 готова. Открой http://localhost:3000"
    Log ""
}

Log "Полный лог: $LogFile"
if (Test-Path $DevLogFile) {
    Log "Dev-лог:     $DevLogFile"
}
Log ""
Log "Скрипт: scripts\diagnose.ps1"

if ($script:FailCount -gt 0) { exit 1 } else { exit 0 }
