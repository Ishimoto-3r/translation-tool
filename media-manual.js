<!-- =========================


const payload = {
category: categoryEl.value || '',
userType: userTypeEl.value || '',
notes: notesEl.value || '',
images: preparedImages.map(x => ({ name: x.name, dataUrl: x.dataUrl }))
};


const res = await fetch('/api/media-manual', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(payload)
});


if (!res.ok){
const t = await res.text().catch(() => '');
throw new Error(`API error: ${res.status} ${t}`);
}


const data = await res.json();
outputEl.value = (data && data.draft) ? data.draft : '';
setStatus('完了');
} catch (e){
console.error(e);
setStatus(`失敗：${e.message || e}`);
} finally {
runBtn.disabled = false;
clearBtn.disabled = false;
fileInput.disabled = false;
}
}


fileInput.addEventListener('change', (ev) => {
prepareFromFiles(ev.target.files).catch(err => {
console.error(err);
setStatus('ファイルの準備に失敗しました');
});
});


clearBtn.addEventListener('click', resetAll);
runBtn.addEventListener('click', run);


copyBtn.addEventListener('click', async () => {
try {
await navigator.clipboard.writeText(outputEl.value || '');
setStatus('コピーしました');
setTimeout(() => setStatus(''), 1200);
} catch {
setStatus('コピーに失敗しました');
}
});
})();
</script>
