
$uri = "https://translation-tool-git-main-ishimotos-projects.vercel.app/api/pdftranslate?direction=ja-zh"
$filePath = "small_test.pdf"
# Content-Typeを意図的に application/pdf に設定
$headers = @{ 
    "x-debug-mode"               = "true"
    "x-vercel-protection-bypass" = "vXJInnCtY2WhMg86tjJUfGrIxH8vVX2L"
}

Write-Output "Testing URL: $uri"
Write-Output "Sending PDF: $filePath"

try {
    $response = Invoke-WebRequest -Uri $uri -Method Post -InFile $filePath -ContentType "application/pdf" -Headers $headers -TimeoutSec 120
    Write-Output "Status: $($response.StatusCode)"
    Write-Output "Headers: $($response.Headers)"
    
    # Bodyの先頭だけ表示（PDFバイナリかもしれないので）
    if ($response.Content.Length -gt 0) {
        $preview = [System.Text.Encoding]::UTF8.GetString($response.Content)
        if ($preview.Length -gt 200) { $preview = $preview.Substring(0, 200) + "..." }
        Write-Output "Body Preview: $preview"
    }
    
    # 成功したらPDFとして保存
    [System.IO.File]::WriteAllBytes("verify_result.pdf", $response.Content)
    Write-Output "Saved response to verify_result.pdf"

} catch {
    Write-Output "Error StatusCode: $($_.Exception.Response.StatusCode.value__)"
    if ($_.Exception.Response) {
        $stream = $_.Exception.Response.GetResponseStream()
        if ($stream) {
            $reader = New-Object System.IO.StreamReader($stream)
            $body = $reader.ReadToEnd()
            Write-Output "Error Body: $body"
        }
    }
    exit 1
}
