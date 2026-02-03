
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
    # Invoke-RestMethod はデフォルトでJSONをパースしようとするが、PDFが返る場合はエラーになるかも。
    # Invoke-WebRequest を使う
    $response = Invoke-WebRequest -Uri $uri -Method Post -InFile $filePath -Headers $headers -ContentType "application/pdf"
    Write-Output "Success: Received statusCode $($response.StatusCode)"
    Write-Output "Content-Type: $($response.Headers['Content-Type'])"
}
catch {
    if ($_.Exception.Response) {
        Write-Output "Error StatusCode: $($_.Exception.Response.StatusCode.value__)"
        $stream = $_.Exception.Response.GetResponseStream()
        if ($stream) {
            $reader = New-Object System.IO.StreamReader($stream)
            $body = $reader.ReadToEnd()
            Write-Output "Error Body: $body"
        }
    }
    else {
        Write-Output "Connection Error: $($_.Exception.Message)"
    }
}
