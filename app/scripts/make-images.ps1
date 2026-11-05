# Renders the two non-digital demo inputs with System.Drawing (Windows only):
#   scripts/tmp/03-scan.png              typed invoice, skewed + speckled like a scan
#   public/samples/04-rao-handwritten-no-po.jpg   handwritten bill on lined paper
# Run once: powershell -File scripts/make-images.ps1

Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force (Join-Path $PSScriptRoot "tmp") | Out-Null
New-Item -ItemType Directory -Force (Join-Path $root "public\samples") | Out-Null
$rand = New-Object System.Random 42

function New-Canvas([string]$bg) {
  $bmp = New-Object System.Drawing.Bitmap 1275, 1650
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"
  $g.TextRenderingHint = "AntiAliasGridFit"
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml($bg))
  return @($bmp, $g)
}

# ---------- 03: scanned typed invoice ----------
$bmp, $g = New-Canvas "#f2efe6"
$g.TranslateTransform(637, 825); $g.RotateTransform(1.3); $g.TranslateTransform(-637, -825)
$ink = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml("#2b2b2b"))
$big = New-Object System.Drawing.Font "Courier New", 30, ([System.Drawing.FontStyle]::Bold)
$f = New-Object System.Drawing.Font "Courier New", 17
$fb = New-Object System.Drawing.Font "Courier New", 17, ([System.Drawing.FontStyle]::Bold)
$lines = @(
  @($big, "NORTHSTAR LOGISTICS"),
  @($f, "Freight & Line-Haul Services"),
  @($f, "8800 Industrial Pkwy, Gary IN 46406"),
  @($f, ""),
  @($fb, "INVOICE"),
  @($f, "Invoice No : 7712"),
  @($f, "Date       : 20 Oct 2026"),
  @($f, "Terms      : Net 30"),
  @($f, "Cust. PO   : PO-2026-0167"),
  @($f, ""),
  @($f, "Bill To: Ironworks Manufacturing, AP Dept"),
  @($f, "         200 Lakeside Blvd, Chicago IL 60601"),
  @($f, ""),
  @($f, "------------------------------------------------------"),
  @($fb, "Description                     Qty    Rate    Amount"),
  @($f, "------------------------------------------------------"),
  @($f, "Freight - Chicago to Dallas       4  1,250.00  5,000.00"),
  @($f, "(full truckload)"),
  @($f, "------------------------------------------------------"),
  @($f, "                              Subtotal       5,000.00"),
  @($f, "                              Tax                0.00"),
  @($fb, "                              TOTAL DUE  USD 5,000.00"),
  @($f, ""),
  @($f, "Remit to: Chase  Acct 7713 0045 9912"),
  @($f, ""),
  @($f, "** COPY - please process **")
)
$y = 110
foreach ($l in $lines) { $g.DrawString($l[1], $l[0], $ink, 120, $y); $y += [int]($l[0].Size * 2.0) }
$g.ResetTransform()
for ($i = 0; $i -lt 9000; $i++) {
  $c = $rand.Next(90, 200)
  $bmp.SetPixel($rand.Next(0, 1275), $rand.Next(0, 1650), [System.Drawing.Color]::FromArgb($c, $c, $c))
}
$edge = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(70, 60, 60, 60))
$g.FillRectangle($edge, 0, 0, 22, 1650)
$stamp = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(150, 180, 40, 40)), 4
$g.DrawEllipse($stamp, 860, 1280, 260, 120)
$g.DrawString("RECEIVED", (New-Object System.Drawing.Font "Arial", 22, ([System.Drawing.FontStyle]::Bold)), (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, 180, 40, 40))), 895, 1322)
$bmp.Save((Join-Path $PSScriptRoot "tmp\03-scan.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# ---------- 04: handwritten bill ----------
$bmp, $g = New-Canvas "#fbfaf4"
$rule = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml("#c9d7ef")), 2
for ($ly = 150; $ly -lt 1620; $ly += 58) { $g.DrawLine($rule, 0, $ly, 1275, $ly) }
$g.DrawLine((New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml("#efb0b0")), 2), 110, 0, 110, 1650)
$fontName = "Ink Free"
$test = New-Object System.Drawing.Font $fontName, 10
if ($test.Name -ne $fontName) { $fontName = "Segoe Print" }
$pen = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml("#1d2a6b"))
$h1 = New-Object System.Drawing.Font $fontName, 34, ([System.Drawing.FontStyle]::Bold)
$h = New-Object System.Drawing.Font $fontName, 22
$g.TranslateTransform(637, 825); $g.RotateTransform(-0.9); $g.TranslateTransform(-637, -825)
$rows = @(
  @($h1, "Rao Electrical Contractors", 140),
  @($h, "Lic. EC-40217   |   Ph 312-555-0148", 150),
  @($h, "Bill No. 118                         Date: Nov 3, 2026", 140),
  @($h, "To: Ironworks Manufacturing - Plant 2", 140),
  @($h, "", 0),
  @($h, "Panel rewiring - Plant 2 (labour)      1    1850.00", 140),
  @($h, "Cable, breakers & fittings (materials)  1     640.00", 140),
  @($h, "", 0),
  @($h, "                         Sub total      2490.00", 140),
  @($h, "                         Tax 8%          199.20", 140),
  @($h1, "                  TOTAL   `$2689.20", 140),
  @($h, "", 0),
  @($h, "Pay to: Fifth Third Bank  a/c 2188 4009 6653", 140),
  @($h, "Payment within 30 days. Thank you!", 140),
  @($h, "", 0),
  @($h1, "               - S. Rao", 140)
)
$y = 96
foreach ($r in $rows) {
  if ($r[1]) { $g.DrawString($r[1], $r[0], $pen, ($r[2] + $rand.Next(-6, 7)), ($y + $rand.Next(-4, 5))) }
  $y += 58 + ($(if ($r[0] -eq $h1) { 20 } else { 0 }))
}
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 82L
$bmp.Save((Join-Path $root "public\samples\04-rao-handwritten-no-po.jpg"), $enc, $ep)
$g.Dispose(); $bmp.Dispose()
Write-Output "images written (handwriting font: $fontName)"
