document.addEventListener('DOMContentLoaded', () => {
  const togglePlayer = document.getElementById('togglePlayer');
  const toggleSearch = document.getElementById('toggleSearch');

  // 从 storage 读取状态
  chrome.storage.sync.get(['playerMaskEnabled', 'searchMaskEnabled'], (data) => {
    togglePlayer.checked = data.playerMaskEnabled !== false; // 默认启用
    toggleSearch.checked = data.searchMaskEnabled !== false; // 默认启用
  });

  // 保存状态
  togglePlayer.addEventListener('change', () => {
    chrome.storage.sync.set({ playerMaskEnabled: togglePlayer.checked });
  });
  toggleSearch.addEventListener('change', () => {
    chrome.storage.sync.set({ searchMaskEnabled: toggleSearch.checked });
  });
});