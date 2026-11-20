# push.ps1 - muestra los últimos commits, te ayuda a hacer commit si hay cambios sin guardar
# y te guía para hacer push.
# Uso:  .\push.ps1            (pregunta todo)
#       .\push.ps1 -N 20      (muestra 20 commits)
# Si Windows no deja ejecutarlo:  powershell -ExecutionPolicy Bypass -File .\push.ps1
# (Ojo: no llamar a las funciones Si/Ask... "si" ya es un alias de PowerShell)
param([int]$N = 10)

function Read-Opcion($pregunta, $porDefecto) {
    $r = Read-Host "$pregunta [$porDefecto]"
    if ([string]::IsNullOrWhiteSpace($r)) { return $porDefecto } else { return $r }
}
function Read-SiNo($pregunta) { return (Read-Opcion "$pregunta (s/n)" 'n') -match '^[sSyY]' }

# Rama remota con la que comparar: la de seguimiento, o <remoto>/<rama> si existe.
function Get-RamaRemota($remoto, $rama) {
    $u = git rev-parse --abbrev-ref '@{u}' 2>$null
    if ($u) { return $u }
    git rev-parse --verify --quiet "refs/remotes/$remoto/$rama" *> $null
    if ($LASTEXITCODE -eq 0) { return "$remoto/$rama" }
    return $null
}

# Commits locales que aún no están en el remoto. Devuelve cuántos hay.
function Show-Pendientes($ref) {
    Write-Host "`n== Commits que se van a subir" -ForegroundColor Cyan
    if (-not $ref) {
        Write-Host '   La rama no existe en el remoto: se subirán todos sus commits.' -ForegroundColor Yellow
        return [int](git rev-list --count HEAD)
    }
    $pend = @(git log --oneline "$ref..HEAD")
    if ($pend.Count) { $pend | ForEach-Object { Write-Host "   $_" } }
    else { Write-Host "   Ninguno: $ref ya tiene todos tus commits." -ForegroundColor Green }
    $detras = [int](git rev-list --count "HEAD..$ref")
    if ($detras -gt 0) { Write-Host "   OJO: el remoto tiene $detras commit(s) que tú no tienes. Haz 'git pull' antes (o fuerza el push)." -ForegroundColor Yellow }
    return $pend.Count
}

git rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -ne 0) { Write-Host 'Esto no es un repositorio git.' -ForegroundColor Red; exit 1 }

$rama = git branch --show-current
$upstream = git rev-parse --abbrev-ref '@{u}' 2>$null

Write-Host "`n== Rama actual: $rama" -ForegroundColor Cyan
if ($upstream) { Write-Host "   Sigue a: $upstream" } else { Write-Host '   Todavía no tiene rama remota asociada (upstream).' -ForegroundColor Yellow }

Write-Host "`n== Remotos (a dónde se puede subir)" -ForegroundColor Cyan
git remote -v

Write-Host "`n== Últimos $N commits" -ForegroundColor Cyan
git log --graph --oneline --decorate -n $N

$remotoDef = if ($upstream) { $upstream.Split('/')[0] } else { 'origin' }
Write-Host "`nConsultando $remotoDef..." -ForegroundColor DarkGray
git fetch --quiet $remotoDef 2>$null

# ---- cambios sin commit: ofrecer crear el commit ----
if (git status --porcelain) {
    Write-Host "`n== Cambios sin commit (NO se suben con push si no haces commit)" -ForegroundColor Yellow
    Write-Host '   M = modificado, ?? = archivo nuevo, D = borrado'
    git status --short
    if (Read-SiNo "`nCrear un commit con TODOS estos cambios?") {
        do { $msg = Read-Host 'Mensaje del commit (qué has cambiado)' } while ([string]::IsNullOrWhiteSpace($msg))
        git add -A
        git commit -m $msg
        if ($LASTEXITCODE -ne 0) { Write-Host 'El commit ha fallado (mira el mensaje de arriba).' -ForegroundColor Red; exit 1 }
        Write-Host 'Commit creado.' -ForegroundColor Green
    } else {
        Write-Host '   Sin commit: esos cambios se quedan solo en tu ordenador.' -ForegroundColor Yellow
    }
}

# ---- ¿hay algo que subir? ----
$ref = Get-RamaRemota $remotoDef $rama
$pendientes = Show-Pendientes $ref
if ($pendientes -eq 0) {
    Write-Host "`nNo hay nada que subir." -ForegroundColor Green
    if (-not (Read-SiNo 'Hacer push de todas formas (por ejemplo, para subir tags)?')) { exit 0 }
}

# ---- opciones del push ----
Write-Host "`n== Opciones del push (Intro = valor por defecto)" -ForegroundColor Cyan
$remoto = Read-Opcion 'Remoto' $remotoDef
$destino = Read-Opcion 'Rama de destino en el remoto' $rama

$args2 = @('push')
if (-not $upstream -or (Read-SiNo 'Guardar esta rama remota como la de seguimiento (-u)?')) { $args2 += '-u' }
if (Read-SiNo 'Subir también los tags (--tags)?') { $args2 += '--tags' }
if (Read-SiNo 'Forzar el push? (reescribe el remoto; usa --force-with-lease, la forma segura)') { $args2 += '--force-with-lease' }
$prueba = Read-SiNo 'Solo simular, sin subir nada (--dry-run)?'
if ($prueba) { $args2 += '--dry-run' }
$args2 += $remoto
$args2 += "${rama}:${destino}"

Write-Host "`nSe va a ejecutar:  git $($args2 -join ' ')" -ForegroundColor Magenta
if (-not (Read-SiNo 'Continuar?')) { Write-Host 'Cancelado.'; exit 0 }

git @args2
if ($LASTEXITCODE -eq 0) {
    if ($prueba) { Write-Host "`nSimulación correcta (no se ha subido nada)." -ForegroundColor Green }
    else { Write-Host "`nPush hecho." -ForegroundColor Green }
} else {
    Write-Host "`nEl push ha fallado (mira el mensaje de arriba). Si dice 'rejected', haz 'git pull' primero." -ForegroundColor Red
}
