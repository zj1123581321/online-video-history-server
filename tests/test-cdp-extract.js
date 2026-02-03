/**
 * 测试 CDP 内容提取脚本
 * 用法: node test-cdp-extract.js
 */

import CDP from 'chrome-remote-interface';

const CDP_HOST = '192.168.31.222';
const CDP_PORT = 9223;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  let client = null;

  try {
    console.log(`[测试] 连接到 CDP: ${CDP_HOST}:${CDP_PORT}`);
    client = await CDP({ host: CDP_HOST, port: CDP_PORT });
    console.log('[测试] ✓ 已连接');

    const { Page, Runtime } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);

    // 导航到历史记录页面
    console.log('[测试] 导航到 YouTube 历史记录页面...');
    await Page.navigate({ url: 'https://www.youtube.com/feed/history' });
    await Page.loadEventFired();
    console.log('[测试] ✓ 页面加载完成');

    // 等待渲染
    await sleep(5000);

    // 滚动到顶部
    console.log('[测试] 滚动到页面顶部...');
    await Runtime.evaluate({ expression: 'window.scrollTo(0, 0)' });
    await sleep(1000);

    // 调试：检查页面元素
    console.log('\n[测试] ========== 页面调试信息 ==========');
    const debugInfo = await Runtime.evaluate({
      expression: `
        (() => {
          return {
            url: window.location.href,
            title: document.title,
            sectionCount: document.querySelectorAll('ytd-item-section-renderer').length,
            videoRendererCount: document.querySelectorAll('ytd-video-renderer').length,
            contentsCount: document.querySelectorAll('#contents').length,
            primaryCount: document.querySelectorAll('#primary').length,
          };
        })()
      `,
      returnByValue: true,
    });

    const debug = debugInfo.result.value;
    console.log(`  URL: ${debug.url}`);
    console.log(`  Title: ${debug.title}`);
    console.log(`  ytd-item-section-renderer: ${debug.sectionCount}`);
    console.log(`  ytd-video-renderer: ${debug.videoRendererCount}`);
    console.log(`  #contents: ${debug.contentsCount}`);
    console.log(`  #primary: ${debug.primaryCount}`);

    // 提取分组信息，并检查每个分组的实际内容
    console.log('\n[测试] ========== 日期分组详情 ==========');
    const sectionsInfo = await Runtime.evaluate({
      expression: `
        (() => {
          const sections = document.querySelectorAll('ytd-item-section-renderer');
          const info = [];
          sections.forEach((section, idx) => {
            const headerRenderer = section.querySelector('ytd-item-section-header-renderer');
            const dateText = headerRenderer?.querySelector('#title')?.textContent?.trim() || '(无标题)';
            const videoCount = section.querySelectorAll('ytd-video-renderer').length;

            // 检查 #contents 下的子元素
            const contents = section.querySelector('#contents');
            const childTags = contents ? Array.from(contents.children).map(el => el.tagName).slice(0, 5) : [];
            const childCount = contents ? contents.children.length : 0;

            info.push({
              index: idx,
              date: dateText,
              videoCount: videoCount,
              childCount: childCount,
              childTags: childTags
            });
          });
          return info;
        })()
      `,
      returnByValue: true,
    });

    const sections = sectionsInfo.result.value || [];
    if (sections.length === 0) {
      console.log('  (未找到任何分组)');
    } else {
      // 只显示前 10 个分组的详情
      for (let i = 0; i < Math.min(sections.length, 10); i++) {
        const sec = sections[i];
        console.log(`  [${sec.index}] ${sec.date}:`);
        console.log(`       视频数: ${sec.videoCount}, 子元素数: ${sec.childCount}`);
        console.log(`       子元素: ${sec.childTags.join(', ') || '(空)'}`);
      }
      if (sections.length > 10) {
        console.log(`  ... 还有 ${sections.length - 10} 个分组`);
      }
    }

    // 检查 YT-LOCKUP-VIEW-MODEL 的结构
    console.log('\n[测试] ========== YT-LOCKUP-VIEW-MODEL 结构检查 ==========');
    const lockupInfo = await Runtime.evaluate({
      expression: `
        (() => {
          const lockup = document.querySelector('yt-lockup-view-model');
          if (!lockup) return { found: false };

          // 获取所有可能包含标题的元素
          const h3 = lockup.querySelector('h3');
          const titleLink = lockup.querySelector('a[href*="watch"]') || lockup.querySelector('a[href*="shorts"]');
          const channelLink = lockup.querySelector('a[href*="channel"]') || lockup.querySelector('a[href*="@"]');

          return {
            found: true,
            outerHTML: lockup.outerHTML.substring(0, 500),
            h3Text: h3?.textContent?.trim() || '',
            titleLinkHref: titleLink?.href || '',
            titleLinkText: titleLink?.textContent?.trim() || '',
            channelLinkText: channelLink?.textContent?.trim() || '',
            innerHTML: lockup.innerHTML.substring(0, 1000),
          };
        })()
      `,
      returnByValue: true,
    });

    const lockup = lockupInfo.result.value;
    if (!lockup.found) {
      console.log('  未找到 yt-lockup-view-model 元素');
    } else {
      console.log('  h3 文本:', lockup.h3Text || '(空)');
      console.log('  标题链接:', lockup.titleLinkHref || '(空)');
      console.log('  标题文本:', lockup.titleLinkText || '(空)');
      console.log('  频道:', lockup.channelLinkText || '(空)');
      console.log('  innerHTML 片段:', lockup.innerHTML.substring(0, 300));
    }

    // 提取视频信息（同时支持新旧元素）
    console.log('\n[测试] ========== 视频列表 ==========');
    const videosInfo = await Runtime.evaluate({
      expression: `
        (() => {
          const items = [];
          const sections = document.querySelectorAll('ytd-item-section-renderer');

          sections.forEach((section) => {
            const headerRenderer = section.querySelector('ytd-item-section-header-renderer');
            const dateText = headerRenderer?.querySelector('#title')?.textContent?.trim() || '';

            // 旧元素: ytd-video-renderer
            const videoRenderers = section.querySelectorAll('ytd-video-renderer');
            videoRenderers.forEach((renderer) => {
              const titleElement = renderer.querySelector('#video-title') || renderer.querySelector('a#video-title-link');
              const title = titleElement?.textContent?.trim() || '';
              const url = titleElement?.href || '';

              let videoId = '';
              if (url) {
                const match = url.match(/[?&]v=([^&]+)/) || url.match(/\\/shorts\\/([^?&\\/]+)/);
                videoId = match ? match[1] : '';
              }

              const channelElement = renderer.querySelector('#channel-name a') || renderer.querySelector('ytd-channel-name a');
              const channelName = channelElement?.textContent?.trim() || '';

              if (title && videoId) {
                items.push({ dateHeader: dateText, videoId, title, channelName, source: 'old' });
              }
            });

            // 新元素: yt-lockup-view-model
            const lockups = section.querySelectorAll('yt-lockup-view-model');
            lockups.forEach((lockup) => {
              // 尝试多种方式获取标题和链接
              const titleLink = lockup.querySelector('a[href*="watch"]') || lockup.querySelector('a[href*="shorts"]');
              const h3 = lockup.querySelector('h3');

              const title = h3?.textContent?.trim() || titleLink?.textContent?.trim() || '';
              const url = titleLink?.href || '';

              let videoId = '';
              if (url) {
                const match = url.match(/[?&]v=([^&]+)/) || url.match(/\\/shorts\\/([^?&\\/]+)/);
                videoId = match ? match[1] : '';
              }

              const channelLink = lockup.querySelector('a[href*="channel"]') || lockup.querySelector('a[href*="@"]');
              const channelName = channelLink?.textContent?.trim() || '';

              if (title && videoId) {
                items.push({ dateHeader: dateText, videoId, title, channelName, source: 'new' });
              }
            });
          });

          return items;
        })()
      `,
      returnByValue: true,
    });

    const videos = videosInfo.result.value || [];
    if (videos.length === 0) {
      console.log('  (未找到任何视频)');
    } else {
      for (let i = 0; i < videos.length; i++) {
        const v = videos[i];
        const titleShort = v.title.length > 40 ? v.title.substring(0, 40) + '...' : v.title;
        console.log(`  [${i + 1}] ${v.dateHeader || '?'} | ${v.videoId} | ${titleShort}`);
      }
    }

    console.log('\n[测试] ✓ 完成');

  } catch (err) {
    console.error('[测试] 错误:', err.message);
  } finally {
    if (client) {
      await client.close();
      console.log('[测试] ✓ 已断开连接');
    }
  }
}

main();
