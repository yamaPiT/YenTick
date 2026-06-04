/**
 * @file popup.test.js
 * @description YenTick Chrome Extension 自動テストコード。
 *   StorageService, ExchangeRateService, GraphRenderer, AppController の機能を検証する。
 *   総合テスト仕様書（SWP6）の各TC項目との対応およびAAAパターンを厳密に遵守。
 * @see SWP6_ソフトウェア総合テスト仕様書・報告書.md
 * @see popup.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StorageService, ExchangeRateService, GraphRenderer, AppController } from './popup.js';

// chrome API およびグローバル環境のモック設定
const mockStorage = {};
global.chrome = {
  storage: {
    local: {
      get: vi.fn((keys, callback) => {
        const result = {};
        keys.forEach(k => {
          result[k] = mockStorage[k];
        });
        callback(result);
      }),
      set: vi.fn((data, callback) => {
        Object.keys(data).forEach(k => {
          mockStorage[k] = data[k];
        });
        if (callback) callback();
      })
    }
  },
  runtime: {
    lastError: null
  }
};

describe('1. StorageService (EEPROM) Tests', () => {
  let storageService;

  beforeEach(() => {
    storageService = new StorageService();
    // モックストレージの初期化
    Object.keys(mockStorage).forEach(k => delete mockStorage[k]);
    vi.clearAllMocks();
  });

  it('TC-NOR-005: キャッシュ保存処理の検証', async () => {
    // Arrange (準備)
    const pair = 'USD_JPY';
    const rateData = {
      rate: 148.256,
      history: [148.1, 148.2, 148.256],
      timestamp: Date.now()
    };

    // Act (実行)
    await storageService.setCache(pair, rateData);

    // Assert (検証)
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(1);
    expect(mockStorage[`cache_${pair}`]).toBeDefined();
    expect(mockStorage[`cache_${pair}`].rate).toBe(148.256);
    expect(mockStorage[`cache_${pair}`].history).toEqual([148.1, 148.2, 148.256]);
  });

  it('TC-ERR-003: キャッシュ期限切れ(24時間超過)の判定', async () => {
    // Arrange (準備)
    const pair = 'USD_JPY';
    const expiredTimestamp = Date.now() - (25 * 60 * 60 * 1000); // 25時間前
    mockStorage[`cache_${pair}`] = {
      rate: 148.256,
      history: [148.1, 148.2, 148.256],
      timestamp: expiredTimestamp
    };

    // Act (実行)
    const result = await storageService.getCache(pair);

    // Assert (検証)
    expect(result).toBeNull(); // 期限切れのためnullが返ることを確認
  });
});

describe('2. ExchangeRateService (API通信部) Tests', () => {
  let rateService;

  beforeEach(() => {
    rateService = new ExchangeRateService();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('TC-NOR-002: 為替データの非同期取得（正常系）の検証', async () => {
    // Arrange (準備)
    const mockApiResponse = {
      rates: { JPY: 148.256 }
    };
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockApiResponse
    });

    // Act (実行)
    const result = await rateService.fetchLatestAndHistory('USD_JPY');

    // Assert (検証)
    expect(fetch).toHaveBeenCalledWith('https://open.er-api.com/v6/latest/USD', expect.any(Object));
    expect(result.rate).toBe(148.256);
    expect(result.history.length).toBe(24);
    expect(result.history[23]).toBe(148.256); // 終端データが最新と一致すること
  });

  it('TC-ERR-006 & TC-ERR-007: 不正データおよび異常値のバリデーション検証', () => {
    // Arrange & Act & Assert
    // 正常値
    expect(rateService.validateData(148.256)).toBe(true);
    // NaN
    expect(rateService.validateData(NaN)).toBe(false);
    // 0
    expect(rateService.validateData(0)).toBe(false);
    // 負数
    expect(rateService.validateData(-148.25)).toBe(false);
    // 文字列
    expect(rateService.validateData("148.25")).toBe(false);
  });
});

describe('3. GraphRenderer (SVG描画エンジン) Tests', () => {
  let renderer;
  let svgElement;

  beforeEach(() => {
    renderer = new GraphRenderer();
    // 仮想DOMにSVGタグを構築
    svgElement = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    document.body.appendChild(svgElement);
  });

  afterEach(() => {
    svgElement.remove();
  });

  it('TC-NOR-004: SVG折れ線グラフ描画の検証', () => {
    // Arrange (準備)
    const mockHistory = [148.100, 148.150, 148.256];

    // Act (実行)
    renderer.render(svgElement, mockHistory);

    // Assert (検証)
    const paths = svgElement.querySelectorAll('path');
    const lines = svgElement.querySelectorAll('line');
    
    expect(paths.length).toBe(2); // areaPath と linePath
    expect(lines.length).toBeGreaterThan(0); // グリッド線
    expect(paths[1].getAttribute('class')).toBe('chart-line');
    expect(paths[1].getAttribute('d')).toContain('M'); // 移動描画コマンドを含むこと
  });

  it('TC-NOR-007: 最高値・最安値表示の配置検証（右端50pxマージン）', () => {
    // Arrange (準備)
    const mockHistory = [148.100, 148.350, 147.900, 148.256];

    // Act (実行)
    renderer.render(svgElement, mockHistory);

    // Assert (検証)
    const yAxisLabels = svgElement.querySelectorAll('.chart-y-axis-label');
    expect(yAxisLabels.length).toBe(2);

    // 最高値テキストの検証
    const textHigh = yAxisLabels[0];
    expect(textHigh.getAttribute('x')).toBe('295'); // 300 - 5
    expect(textHigh.getAttribute('y')).toBe('23');  // padding.top(15) + 8
    expect(textHigh.textContent).toBe('148.350');

    // 最安値テキストの検証
    const textLow = yAxisLabels[1];
    expect(textLow.getAttribute('x')).toBe('295');
    expect(textLow.getAttribute('y')).toBe('135'); // 150 - padding.bottom(15)
    expect(textLow.textContent).toBe('147.900');
  });

  it('TC-NOR-008: 現在値インジケータの動的追従描画検証', () => {
    // Arrange (準備)
    const mockHistory = [148.100, 148.350, 147.900, 148.200];
    const currentRate = 148.200;

    // Act (実行)
    renderer.render(svgElement, mockHistory, currentRate);

    // Assert (検証)
    const arrow = svgElement.querySelector('.chart-indicator-arrow');
    const bg = svgElement.querySelector('.chart-indicator-bg');
    const text = svgElement.querySelector('.chart-indicator-text');

    expect(arrow).not.toBeNull();
    expect(bg).not.toBeNull();
    expect(text).not.toBeNull();

    // ◀の先端座標が W - padding.right + 2 = 252 であること
    const points = arrow.getAttribute('points');
    expect(points).toContain('252,');

    // テキストに現在値が正しく小数点以下3桁で表示されていること
    expect(text.textContent).toBe('148.200');
    expect(text.getAttribute('x')).toBe('295');
  });

  it('TC-ERR-009: グラフデータ境界値・異常値における描画・座標計算処理のガード検証', () => {
    // ケースA: 全点同一値
    const identicalHistory = [148.000, 148.000, 148.000];
    renderer.render(svgElement, identicalHistory, 148.000);
    
    // ゼロ除算が発生せず正常に描画されているか
    const pathsIdentical = svgElement.querySelectorAll('path');
    expect(pathsIdentical.length).toBe(2);
    expect(svgElement.querySelector('.chart-y-axis-label').textContent).toBe('148.000');

    // ケースB: 最新レートが履歴範囲外（最高値より高い / 最安値より低い）
    const mockHistory = [148.100, 148.350, 147.900, 148.256];
    
    // 履歴外の非常に高いレート
    renderer.render(svgElement, mockHistory, 150.000);
    const arrowHigh = svgElement.querySelector('.chart-indicator-arrow');
    const pointsHigh = arrowHigh.getAttribute('points');
    // Y座標が padding.top (15) にクリッピングされているか検証
    const yHigh = parseFloat(pointsHigh.split(' ')[0].split(',')[1]);
    expect(yHigh).toBe(15);

    // 履歴外の非常に低いレート
    renderer.render(svgElement, mockHistory, 140.000);
    const arrowLow = svgElement.querySelector('.chart-indicator-arrow');
    const pointsLow = arrowLow.getAttribute('points');
    // Y座標が padding.top + drawHeight = 15 + 120 = 135 にクリッピングされているか検証
    const yLow = parseFloat(pointsLow.split(' ')[0].split(',')[1]);
    expect(yLow).toBe(135);
  });
});

describe('4. AppController (全体制御) Tests', () => {
  let controller;
  let rateService;
  let storageService;
  let graphRenderer;

  beforeEach(() => {
    // HTMLのモック骨格をDOMに設定
    document.body.innerHTML = `
      <div id="view-loading" class="view active"></div>
      <div id="view-data" class="view">
        <span id="rate-value">000.000</span>
        <span id="rate-time">-</span>
        <span class="status-indicator">LIVE</span>
        <span id="stat-high">-</span>
        <span id="stat-low">-</span>
        <svg id="trend-chart"></svg>
      </div>
      <div id="view-error" class="view">
        <p id="error-message"></p>
        <div id="cache-fallback-box" class="hidden">
          <span id="cache-rate-value"></span>
          <span id="cache-time"></span>
        </div>
        <button id="btn-reload"></button>
      </div>
    `;

    rateService = new ExchangeRateService();
    storageService = new StorageService();
    graphRenderer = new GraphRenderer();
    controller = new AppController(rateService, storageService, graphRenderer);
  });

  it('TC-NOR-001: 起動時のローディングおよび正常遷移の検証', async () => {
    // Arrange (準備)
    const mockData = {
      rate: 148.256,
      history: Array(24).fill(148.2),
      timestamp: Date.now()
    };
    vi.spyOn(rateService, 'fetchLatestAndHistory').mockResolvedValue(mockData);
    vi.spyOn(storageService, 'setCache').mockResolvedValue();

    // Act (実行)
    controller.showLoading();
    expect(document.getElementById('view-loading').classList.contains('active')).toBe(true);

    await controller.refreshData();

    // Assert (検証)
    expect(document.getElementById('view-data').classList.contains('active')).toBe(true);
    expect(document.getElementById('rate-value').textContent).toBe('148.256');
    expect(rateService.fetchLatestAndHistory).toHaveBeenCalledTimes(1);
    expect(storageService.setCache).toHaveBeenCalledWith('USD_JPY', mockData);
  });

  it('TC-ERR-001: オフライン時のキャッシュ縮退運転(フォールバック)の検証', async () => {
    // Arrange (準備)
    const mockCachedData = {
      rate: 147.950,
      history: Array(24).fill(147.9),
      timestamp: Date.now() - 3600000 // 1時間前
    };
    vi.spyOn(rateService, 'fetchLatestAndHistory').mockRejectedValue(new Error("Failed to fetch"));
    vi.spyOn(storageService, 'getCache').mockResolvedValue(mockCachedData);

    // Act (実行)
    await controller.refreshData();

    // Assert (検証)
    // view-dataに遷移し、最終更新日時警告付きでキャッシュ値を表示することを確認
    expect(document.getElementById('view-data').classList.contains('active')).toBe(true);
    expect(document.getElementById('rate-value').textContent).toBe('147.950');
    expect(document.querySelector('.status-indicator').textContent).toBe('OFFLINE');
  });
});
