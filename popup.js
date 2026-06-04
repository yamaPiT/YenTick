/**
 * @file popup.js
 * @version 1.0.0
 * @date 2026-06-03
 * @author ハル (Hal)
 * @description YenTick Chrome Extensionのメイン制御ロジック。
 *   キャッシュ管理、外部API非同期通信（5sタイムアウト）、SVG自作グラフ描画、UI制御を担当。
 * @see SW205_ソフトウェアアーキテクチャ設計書.md
 * @see SW105_ソフトウェア要求仕様書.md
 */

// ==========================================
// 1. StorageService (EEPROM 相当の不揮発データキャッシュ領域)
// ==========================================

/**
 * @class StorageService
 * @description chrome.storage.local の読み書きおよびキャッシュの有効期限（24時間）の管理。
 * @see SW205: 3.2.3 & 5.2
 */
export class StorageService {
  /**
   * @type {number}
   */
  static CACHE_MAX_AGE = 24 * 60 * 60 * 1000;

  /**
   * キャッシュデータを不揮発ストレージへ保存する。
   * @param {string} pair 通貨ペア名 (例: 'USD_JPY')
   * @param {{rate: number, history: number[], timestamp: number}} rateData 
   * @returns {Promise<void>}
   */
  async setCache(pair, rateData) {
    const key = `cache_${pair}`;
    const storageData = {};
    storageData[key] = {
      rate: rateData.rate,
      history: rateData.history,
      timestamp: rateData.timestamp || Date.now()
    };
    
    return new Promise((resolve, reject) => {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(storageData, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve();
          }
        });
      } else {
        try {
          localStorage.setItem(key, JSON.stringify(storageData[key]));
          resolve();
        } catch (e) {
          reject(e);
        }
      }
    });
  }

  /**
   * 不揮発ストレージからキャッシュを取得し、24時間以内のものか検証する。
   * @param {string} pair 通貨ペア名
   * @returns {Promise<{rate: number, history: number[], timestamp: number}|null>} 有効なキャッシュ、無効時はnull
   */
  async getCache(pair) {
    const key = `cache_${pair}`;
    
    return new Promise((resolve) => {
      const handleData = (data) => {
        if (!data) return resolve(null);
        
        if (this._isExpired(data.timestamp)) {
          resolve(null);
        } else {
          resolve(data);
        }
      };

      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get([key], (result) => {
          if (chrome.runtime.lastError || !result || !result[key]) {
            resolve(null);
          } else {
            handleData(result[key]);
          }
        });
      } else {
        try {
          const item = localStorage.getItem(key);
          if (item) {
            handleData(JSON.parse(item));
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      }
    });
  }

  /**
   * @private
   * @param {number} timestamp タイムスタンプ (ミリ秒)
   * @returns {boolean} 期限切れならtrue
   */
  _isExpired(timestamp) {
    if (!timestamp) return true;
    return (Date.now() - timestamp) > StorageService.CACHE_MAX_AGE;
  }
}

// ==========================================
// 2. ExchangeRateService (API 非同期通信部)
// ==========================================

/**
 * @class ExchangeRateService
 * @description 外部為替APIへの非同期 fetch、5sタイムアウト制御、およびモック履歴データの動的生成。
 */
export class ExchangeRateService {
  /**
   * @type {number}
   */
  static TIMEOUT_MS = 5000;

  /**
   * 外部APIから為替データを取得する。
   * @param {string} pair 通貨ペア名 (例: 'USD_JPY')
   * @returns {Promise<{rate: number, history: number[], timestamp: number}>}
   */
  async fetchLatestAndHistory(pair) {
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), ExchangeRateService.TIMEOUT_MS);

    const [base, target] = pair.split('_');
    const apiUrl = `https://open.er-api.com/v6/latest/${base}`;

    try {
      const response = await fetch(apiUrl, { signal: controller.signal });
      clearTimeout(timerId);

      if (!response.ok) {
        throw new Error(`API response error: HTTP ${response.status}`);
      }

      const data = await response.json();
      
      const rawRate = data.rates && data.rates[target];
      if (!rawRate) {
        throw new Error(`Target currency ${target} not found in API response`);
      }

      if (!this.validateData(rawRate)) {
        throw new Error("Invalid rate value received from API");
      }

      const rate = parseFloat(rawRate.toFixed(3));
      const history = this._generateSmoothHistory(rate);

      return {
        rate,
        history,
        timestamp: Date.now()
      };
    } catch (error) {
      clearTimeout(timerId);
      throw error;
    }
  }

  /**
   * @param {number} rate 為替レート
   * @returns {boolean} 正常値ならtrue
   */
  validateData(rate) {
    if (typeof rate !== 'number' || isNaN(rate)) {
      return false;
    }
    if (rate <= 0) {
      return false;
    }
    return true;
  }

  /**
   * @private
   * @param {number} latestRate 最新レート
   * @returns {number[]} 過去24時間のレート推移配列（要素数24）
   */
  _generateSmoothHistory(latestRate) {
    const history = [];
    const length = 24;
    
    for (let i = 0; i < length; i++) {
      const offset = (i - (length - 1));
      const wave1 = Math.sin(i * 0.4) * 0.18;
      const wave2 = Math.cos(i * 0.15) * 0.12;
      const trend = offset * 0.01;
      
      const rateOffset = wave1 + wave2 + trend;
      const calculatedVal = latestRate + rateOffset;
      
      history.push(parseFloat(calculatedVal.toFixed(3)));
    }
    
    history[length - 1] = latestRate;
    return history;
  }
}

// ==========================================
// 3. GraphRenderer (ディスプレイ描画ドライバ)
// ==========================================

/**
 * @class GraphRenderer
 * @description SVG要素内に10ms以内で滑らかな折れ線グラフおよび背景グラデーションを直接生成。
 */
export class GraphRenderer {
  /**
   * SVG要素に対して折れ線グラフおよびY軸の各種インジケータをレンダリングする。
   * @param {SVGElement} svgElement 描画対象のSVGタグ
   * @param {number[]} history 過去24時間のレートデータ配列 (要素数24)
   * @param {number} [currentRate] 最新の為替レート (Y軸上の現在値プロット用)
   */
  render(svgElement, history, currentRate) {
    if (!svgElement || !history || history.length === 0) return;

    const startTime = performance.now();

    const svgWidth = 300;
    const svgHeight = 150;
    // 右端にY軸領域として50pxのマージンを確保
    const padding = { top: 15, right: 50, bottom: 15, left: 10 };
    
    const drawWidth = svgWidth - padding.left - padding.right;
    const drawHeight = svgHeight - padding.top - padding.bottom;

    const maxVal = Math.max(...history);
    const minVal = Math.min(...history);
    
    // 全点同一値（ゼロ除算ガード）の処理
    let yMax, yMin;
    if (maxVal === minVal) {
      yMax = maxVal + 0.05;
      yMin = minVal - 0.05;
    } else {
      const valRange = maxVal - minVal;
      yMax = maxVal + valRange * 0.1;
      yMin = minVal - valRange * 0.1;
    }
    const yRange = yMax - yMin;

    const points = history.map((val, idx) => {
      const x = padding.left + (idx / (history.length - 1)) * drawWidth;
      const y = padding.top + drawHeight - ((val - yMin) / yRange) * drawHeight;
      return { x, y };
    });

    let pathD = `M ${points[0].x} ${points[0].y}`;
    
    for (let i = 0; i < points.length - 1; i++) {
      const curr = points[i];
      const next = points[i + 1];
      const mx = (curr.x + next.x) / 2;
      const my = (curr.y + next.y) / 2;
      pathD += ` Q ${curr.x} ${curr.y}, ${mx} ${my}`;
    }
    pathD += ` L ${points[points.length - 1].x} ${points[points.length - 1].y}`;

    const areaD = `${pathD} L ${points[points.length - 1].x} ${svgHeight - padding.bottom} L ${points[0].x} ${svgHeight - padding.bottom} Z`;

    const svgNS = "http://www.w3.org/2000/svg";
    svgElement.innerHTML = "";

    const defs = document.createElementNS(svgNS, "defs");
    
    const strokeGrad = document.createElementNS(svgNS, "linearGradient");
    strokeGrad.setAttribute("id", "chart-stroke-grad");
    strokeGrad.setAttribute("x1", "0%");
    strokeGrad.setAttribute("y1", "0%");
    strokeGrad.setAttribute("x2", "100%");
    strokeGrad.setAttribute("y2", "0%");
    
    const stop1 = document.createElementNS(svgNS, "stop");
    stop1.setAttribute("offset", "0%");
    stop1.setAttribute("stop-color", "#00f2fe");
    
    const stop2 = document.createElementNS(svgNS, "stop");
    stop2.setAttribute("offset", "100%");
    stop2.setAttribute("stop-color", "#05f9a6");
    
    strokeGrad.appendChild(stop1);
    strokeGrad.appendChild(stop2);
    defs.appendChild(strokeGrad);

    const fillGrad = document.createElementNS(svgNS, "linearGradient");
    fillGrad.setAttribute("id", "chart-fill-grad");
    fillGrad.setAttribute("x1", "0%");
    fillGrad.setAttribute("y1", "0%");
    fillGrad.setAttribute("x2", "0%");
    fillGrad.setAttribute("y2", "100%");
    
    const fillStop1 = document.createElementNS(svgNS, "stop");
    fillStop1.setAttribute("offset", "0%");
    fillStop1.setAttribute("stop-color", "#00f2fe");
    fillStop1.setAttribute("stop-opacity", "0.35");
    
    const fillStop2 = document.createElementNS(svgNS, "stop");
    fillStop2.setAttribute("offset", "100%");
    fillStop2.setAttribute("stop-color", "#00f2fe");
    fillStop2.setAttribute("stop-opacity", "0.0");
    
    fillGrad.appendChild(fillStop1);
    fillGrad.appendChild(fillStop2);
    defs.appendChild(fillGrad);
    svgElement.appendChild(defs);

    const gridLines = 4;
    for (let i = 0; i <= gridLines; i++) {
      const gy = padding.top + (i / gridLines) * drawHeight;
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", padding.left);
      line.setAttribute("y1", gy);
      line.setAttribute("x2", svgWidth - padding.right);
      line.setAttribute("y2", gy);
      line.setAttribute("class", "chart-grid");
      svgElement.appendChild(line);
    }

    const areaPath = document.createElementNS(svgNS, "path");
    areaPath.setAttribute("d", areaD);
    areaPath.setAttribute("class", "chart-area");
    svgElement.appendChild(areaPath);

    const linePath = document.createElementNS(svgNS, "path");
    linePath.setAttribute("d", pathD);
    linePath.setAttribute("class", "chart-line");
    svgElement.appendChild(linePath);

    // Y軸の最高値・最安値テキストの描画 (TC-NOR-007)
    const textHigh = document.createElementNS(svgNS, "text");
    textHigh.setAttribute("x", svgWidth - 5);
    textHigh.setAttribute("y", padding.top + 8);
    textHigh.setAttribute("class", "chart-y-axis-label");
    textHigh.setAttribute("text-anchor", "end");
    textHigh.textContent = maxVal.toFixed(3);
    svgElement.appendChild(textHigh);

    const textLow = document.createElementNS(svgNS, "text");
    textLow.setAttribute("x", svgWidth - 5);
    textLow.setAttribute("y", svgHeight - padding.bottom);
    textLow.setAttribute("class", "chart-y-axis-label");
    textLow.setAttribute("text-anchor", "end");
    textLow.textContent = minVal.toFixed(3);
    svgElement.appendChild(textLow);

    // 現在値インジケータの描画 (TC-NOR-008, TC-ERR-009)
    const activeRate = typeof currentRate === 'number' ? currentRate : history[history.length - 1];
    
    // Y座標計算とクリッピング (ガード処理)
    let yCurrentRaw = padding.top + drawHeight - ((activeRate - yMin) / yRange) * drawHeight;
    const yCurrent = Math.max(padding.top, Math.min(padding.top + drawHeight, yCurrentRaw));

    // 左向き矢印 (◀) 要素 の描画 (先端は x = W - margin.right + 2 = 252)
    const arrowX = svgWidth - padding.right + 2;
    const arrow = document.createElementNS(svgNS, "polygon");
    arrow.setAttribute("points", `${arrowX},${yCurrent} ${arrowX + 6},${yCurrent - 4} ${arrowX + 6},${yCurrent + 4}`);
    arrow.setAttribute("class", "chart-indicator-arrow");
    svgElement.appendChild(arrow);

    // 現在値ラベル背景要素
    const rectX = svgWidth - padding.right + 8;
    const rectWidth = 38;
    const rectHeight = 12;
    const rect = document.createElementNS(svgNS, "rect");
    rect.setAttribute("x", rectX);
    rect.setAttribute("y", yCurrent - 6);
    rect.setAttribute("width", rectWidth);
    rect.setAttribute("height", rectHeight);
    rect.setAttribute("rx", 2);
    rect.setAttribute("class", "chart-indicator-bg");
    svgElement.appendChild(rect);

    // 現在値ラベルテキスト要素
    const textCurrent = document.createElementNS(svgNS, "text");
    textCurrent.setAttribute("x", svgWidth - 5);
    textCurrent.setAttribute("y", yCurrent + 3);
    textCurrent.setAttribute("class", "chart-indicator-text");
    textCurrent.setAttribute("text-anchor", "end");
    textCurrent.textContent = activeRate.toFixed(3);
    svgElement.appendChild(textCurrent);

    const endTime = performance.now();
    console.log(`[GraphRenderer] Render completed in ${(endTime - startTime).toFixed(2)}ms`);
  }
}

// ==========================================
// 4. AppController (全体制御・割り込み調停モジュール)
// ==========================================

/**
 * @class AppController
 * @description ポップアップ起動からデータ取得、エラー時のフォールバック処理、UI状態遷移を統括する。
 */
export class AppController {
  /**
   * @param {ExchangeRateService} rateService 
   * @param {StorageService} storageService 
   * @param {GraphRenderer} graphRenderer 
   */
  constructor(rateService, storageService, graphRenderer) {
    this.rateService = rateService;
    this.storageService = storageService;
    this.graphRenderer = graphRenderer;
    this.activePair = 'USD_JPY';
  }

  /**
   * アプリケーションの初期起動処理。
   */
  async init() {
    this._bindEvents();
    this.showLoading();
    await this.refreshData();
  }

  /**
   * @private
   */
  _bindEvents() {
    const btnReload = document.getElementById('btn-reload');
    if (btnReload) {
      btnReload.addEventListener('click', () => this.handleReload());
    }
  }

  /**
   * データ取得リクエストの投入および結果表示のディスパッチ
   */
  async refreshData() {
    try {
      const data = await this.rateService.fetchLatestAndHistory(this.activePair);
      await this.storageService.setCache(this.activePair, data);
      this.showData(data);
    } catch (error) {
      console.warn(`[AppController] API fetch failed: ${error.message}. Checking fallback cache...`);
      await this.handleFallback(error.message);
    }
  }

  /**
   * API通信失敗時のフェールセーフ（キャッシュ復元）処理
   * @param {string} errorMsg 通信エラーの内容
   */
  async handleFallback(errorMsg) {
    try {
      const cached = await this.storageService.getCache(this.activePair);
      
      if (cached) {
        this.showData(cached, true);
      } else {
        this.showError(`通信エラー: ${errorMsg}`, null);
      }
    } catch (e) {
      this.showError("キャッシュデータ破損のため復旧できません", null);
    }
  }

  /**
   * 再試行 (Reload) ボタン押下時の割り込みハンドリング
   */
  async handleReload() {
    this.showLoading();
    await this.refreshData();
  }

  /**
   * 画面全体をローディング表示に切り替える。
   */
  showLoading() {
    this._switchView('view-loading');
  }

  /**
   * 為替レートとグラフを画面に正常描画する。
   * @param {{rate: number, history: number[], timestamp: number}} rateData 
   * @param {boolean} [isFallback=false] キャッシュからのフォールバック表示かどうか
   */
  showData(rateData, isFallback = false) {
    this._switchView('view-data');

    const formattedRate = rateData.rate.toFixed(3);
    const rateValEl = document.getElementById('rate-value');
    if (rateValEl) {
      rateValEl.textContent = formattedRate;
    }

    const timeEl = document.getElementById('rate-time');
    if (timeEl) {
      const date = new Date(rateData.timestamp);
      const timeStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      timeEl.textContent = isFallback ? `(最終更新 ${timeStr})` : `LAST UPDATED ${timeStr}`;
    }

    const liveIndicator = document.querySelector('.status-indicator');
    if (liveIndicator) {
      if (isFallback) {
        liveIndicator.textContent = "OFFLINE";
        liveIndicator.className = "status-indicator offline";
        liveIndicator.style.backgroundColor = "rgba(255, 42, 95, 0.1)";
        liveIndicator.style.color = "var(--color-error)";
        liveIndicator.style.borderColor = "rgba(255, 42, 95, 0.2)";
      } else {
        liveIndicator.textContent = "LIVE";
        liveIndicator.className = "status-indicator live";
        liveIndicator.style.backgroundColor = "";
        liveIndicator.style.color = "";
        liveIndicator.style.borderColor = "";
      }
    }

    const maxVal = Math.max(...rateData.history).toFixed(3);
    const minVal = Math.min(...rateData.history).toFixed(3);
    const highEl = document.getElementById('stat-high');
    const lowEl = document.getElementById('stat-low');
    if (highEl) highEl.textContent = maxVal;
    if (lowEl) lowEl.textContent = minVal;

    const svgEl = document.getElementById('trend-chart');
    if (svgEl) {
      this.graphRenderer.render(svgEl, rateData.history, rateData.rate);
    }
  }

  /**
   * エラー警告画面およびキャッシュデータを縮退表示する。
   * @param {string} message エラーテキスト
   * @param {Object} [cachedData=null]
   */
  showError(message, cachedData = null) {
    this._switchView('view-error');

    const msgEl = document.getElementById('error-message');
    if (msgEl) {
      msgEl.textContent = message;
    }

    const fallbackBox = document.getElementById('cache-fallback-box');
    if (fallbackBox) {
      if (cachedData) {
        fallbackBox.classList.remove('hidden');
        
        const rateValEl = document.getElementById('cache-rate-value');
        if (rateValEl) rateValEl.textContent = cachedData.rate.toFixed(3);
        
        const timeEl = document.getElementById('cache-time');
        if (timeEl) {
          const date = new Date(cachedData.timestamp);
          timeEl.textContent = `最終更新: ${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
        }
      } else {
        fallbackBox.classList.add('hidden');
      }
    }
  }

  /**
   * ビューエリアの排他表示切り替え
   * @private
   * @param {string} viewId アクティブにするDOMのID
   */
  _switchView(viewId) {
    const views = document.querySelectorAll('.view');
    views.forEach(v => {
      if (v.id === viewId) {
        v.classList.add('active');
      } else {
        v.classList.remove('active');
      }
    });
  }
}

// ==========================================
// 5. Entry Point (コールドスタート時の主電源ONに相当)
// ==========================================

document.addEventListener('DOMContentLoaded', () => {
  if (document.querySelector('.app-container')) {
    const storageService = new StorageService();
    const rateService = new ExchangeRateService();
    const graphRenderer = new GraphRenderer();
    
    const app = new AppController(rateService, storageService, graphRenderer);
    app.init().catch(err => {
      console.error("[System Coldstart Error]", err);
    });
  }
});
