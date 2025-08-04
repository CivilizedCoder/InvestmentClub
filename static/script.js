// static/script.js
document.addEventListener('DOMContentLoaded', () => {
    // --- GLOBAL STATE ---
    let stockChart, timelineChart, portfolioChart;
    let currentStockData = null;
    let portfolio = [];

    // --- INITIALIZATION ---
    async function initialize() {
        initializeEventListeners();
        await fetchPortfolio();
        initializeTabs(); // Initialize tabs after fetching data
    }

    initialize();

    // --- EVENT LISTENERS SETUP ---
    function initializeEventListeners() {
        const fetchBtn = document.getElementById('fetchBtn');
        if (fetchBtn) fetchBtn.addEventListener('click', fetchStockData);
        
        const tickerInput = document.getElementById('tickerInput');
        if(tickerInput) tickerInput.addEventListener('keypress', e => e.key === 'Enter' && fetchStockData());
    }

    // --- TAB HANDLING ---
    function initializeTabs() {
        const navLinks = document.querySelectorAll('.nav-link');
        const tabContents = document.querySelectorAll('.tab-content');

        navLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const tab = link.dataset.tab;

                navLinks.forEach(lnk => lnk.classList.remove('active'));
                link.classList.add('active');

                tabContents.forEach(content => {
                    content.classList.remove('active-content');
                    content.classList.add('hidden');
                    if (content.id === `${tab}Content`) {
                        content.classList.remove('hidden');
                        content.classList.add('active-content');
                    }
                });
                
                // FIX: Render content only when the tab is made active
                if (tab === 'home') {
                    // Reset the home view to show the summary, not a stale search
                    const homeDashboard = document.getElementById('homeDashboard');
                    const stockDataView = document.getElementById('stockDataView');
                    if (homeDashboard) homeDashboard.classList.remove('hidden');
                    if (stockDataView) stockDataView.classList.add('hidden');
                    renderPortfolioSummary();
                } else if (tab === 'portfolio') {
                    renderPortfolioList();
                    renderPortfolioChart();
                }
            });
        });
        
        // Trigger a click on the default active tab to load its content
        document.querySelector('.nav-link.active').click();
    }
    
    // --- STOCK SEARCH ---
    function fetchStockData() {
        const ticker = document.getElementById('tickerInput').value.trim().toUpperCase();
        if (!ticker) return;
        
        const homeDashboard = document.getElementById('homeDashboard');
        const stockDataView = document.getElementById('stockDataView');
        if (homeDashboard) homeDashboard.innerHTML = '<p class="text-center card">Loading...</p>';
        if (stockDataView) stockDataView.classList.add('hidden');

        fetch(`/api/stock/${ticker}`)
            .then(response => response.ok ? response.json() : response.json().then(err => { throw new Error(err.error) }))
            .then(data => {
                currentStockData = data;
                if (homeDashboard) homeDashboard.classList.add('hidden');
                
                // Inject the detailed stock view HTML if it doesn't exist
                if (stockDataView && stockDataView.innerHTML.trim() === '') {
                    stockDataView.innerHTML = getStockDataViewHtml();
                    // Re-initialize listeners for the newly added elements
                    document.getElementById('isRealCheckbox').addEventListener('change', toggleRealPurchaseInputs);
                    document.getElementById('addToPortfolioBtn').addEventListener('click', addStockToPortfolio);
                    document.querySelectorAll('input[name="purchaseType"]').forEach(radio => radio.addEventListener('change', togglePurchaseTypeInputs));
                }
                
                if (stockDataView) stockDataView.classList.remove('hidden');
                
                updateStockInfoUI(data);
                setupIndividualStockChart(data.historical);
                const portfolioTicker = document.getElementById('portfolioTicker');
                if (portfolioTicker) portfolioTicker.textContent = data.symbol;
            })
            .catch(error => {
                if (homeDashboard) {
                    homeDashboard.innerHTML = `<p class="text-red-400 text-center card">Error: ${error.message}</p>`;
                    homeDashboard.classList.remove('hidden');
                }
            });
    }

    function updateStockInfoUI(data) {
        const formatCurrency = (val) => val ? `$${Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'N/A';
        const formatLargeNumber = (val) => val ? Number(val).toLocaleString() : 'N/A';
        
        document.getElementById('stockName').textContent = data.longName || 'N/A';
        document.getElementById('stockSymbol').textContent = data.symbol || 'N/A';
        document.getElementById('currentPrice').textContent = formatCurrency(data.currentPrice);
        document.getElementById('dayHigh').textContent = formatCurrency(data.dayHigh);
        document.getElementById('dayLow').textContent = formatCurrency(data.dayLow);
        document.getElementById('fiftyTwoWeekHigh').textContent = formatCurrency(data.fiftyTwoWeekHigh);
        document.getElementById('fiftyTwoWeekLow').textContent = formatCurrency(data.fiftyTwoWeekLow);
        document.getElementById('marketCap').textContent = `$${formatLargeNumber(data.marketCap)}`;
        document.getElementById('volume').textContent = formatLargeNumber(data.volume);
        document.getElementById('forwardPE').textContent = data.forwardPE ? data.forwardPE.toFixed(2) : 'N/A';
    }
    
    // --- DATABASE & PORTFOLIO LOGIC ---
    async function fetchPortfolio() {
        try {
            const response = await fetch('/api/portfolio');
            if (!response.ok) throw new Error('Failed to fetch portfolio');
            portfolio = await response.json();
        } catch (error) {
            console.error("Fetch portfolio error:", error);
            portfolio = [];
        }
    }
    
    async function renderPortfolioSummary() {
        const welcomeMessage = document.getElementById('welcomeMessage');
        const portfolioSummary = document.getElementById('portfolioSummary');
        const summaryList = document.getElementById('portfolioSummaryList');

        if (!welcomeMessage || !portfolioSummary || !summaryList) return;

        if (portfolio.length === 0) {
            welcomeMessage.classList.remove('hidden');
            portfolioSummary.classList.add('hidden');
            return;
        }

        welcomeMessage.classList.add('hidden');
        portfolioSummary.classList.remove('hidden');
        summaryList.innerHTML = '<p>Loading live prices...</p>';

        try {
            const tickers = portfolio.map(p => p.symbol);
            const response = await fetch('/api/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tickers }) });
            if (!response.ok) throw new Error('Failed to fetch quotes');
            
            const quotes = await response.json();
            summaryList.innerHTML = '';

            portfolio.forEach(holding => {
                const quote = quotes[holding.symbol];
                const currentPrice = quote ? quote.currentPrice : null;
                const prevClose = quote ? quote.previousClose : null;
                let priceChange = 0, priceChangePercent = 0;
                if (currentPrice && prevClose) {
                    priceChange = currentPrice - prevClose;
                    priceChangePercent = (priceChange / prevClose) * 100;
                }
                const changeColor = priceChange >= 0 ? 'text-green-400' : 'text-red-400';
                const card = document.createElement('div');
                card.className = 'summary-card';
                card.innerHTML = `<div class="flex justify-between items-center"><p class="font-bold text-lg">${holding.symbol}</p><p class="font-semibold text-lg">${currentPrice ? '$' + currentPrice.toFixed(2) : 'N/A'}</p></div><p class="text-sm text-gray-400 truncate">${holding.longName}</p><div class="text-right mt-2 ${changeColor}"><span class="font-medium">${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}</span><span>(${priceChangePercent.toFixed(2)}%)</span></div>`;
                summaryList.appendChild(card);
            });
        } catch (error) {
            console.error("Error fetching portfolio summary:", error);
            summaryList.innerHTML = '<p class="text-red-400">Could not load live prices.</p>';
        }
    }

    function renderPortfolioList() {
        const listEl = document.getElementById('portfolioList');
        if (!listEl) return;
        
        listEl.innerHTML = '';
        const emptyMsg = document.getElementById('emptyPortfolioMsg');
        if(emptyMsg) emptyMsg.classList.toggle('hidden', portfolio.length > 0);

        portfolio.forEach(item => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'portfolio-item';
            let details = item.isReal ? (item.purchaseType === 'quantity' ? `(${item.quantity} shares @ $${item.price.toFixed(2)})` : `($${item.dollarValue.toLocaleString()} invested)`) : '(Tracking)';
            itemDiv.innerHTML = `<div class="flex justify-between items-center"><div><p class="font-bold">${item.symbol}</p><p class="text-sm text-gray-400">${item.longName}</p></div><div class="text-right"><p class="font-semibold">${details}</p><button class="remove-btn" data-id="${item.id}">Remove</button></div></div>`;
            listEl.appendChild(itemDiv);
        });
        listEl.querySelectorAll('.remove-btn').forEach(btn => btn.addEventListener('click', removePortfolioItem));
    }

    function toggleRealPurchaseInputs() {
        document.getElementById('realPurchaseInputs').classList.toggle('hidden', !this.checked);
    }

    function togglePurchaseTypeInputs() {
        const purchaseType = document.querySelector('input[name="purchaseType"]:checked').value;
        document.getElementById('quantityInputs').classList.toggle('hidden', purchaseType !== 'quantity');
        document.getElementById('valueInputs').classList.toggle('hidden', purchaseType === 'quantity');
    }

    async function addStockToPortfolio() {
        if (!currentStockData) return;
        const isReal = document.getElementById('isRealCheckbox').checked;
        const newHolding = { symbol: currentStockData.symbol, longName: currentStockData.longName, isReal: isReal };
        if (isReal) {
            const purchaseType = document.querySelector('input[name="purchaseType"]:checked').value;
            newHolding.purchaseType = purchaseType;
            newHolding.date = document.getElementById('purchaseDate').value;
            if (purchaseType === 'quantity') {
                newHolding.quantity = parseFloat(document.getElementById('purchaseQuantity').value);
                newHolding.price = parseFloat(document.getElementById('purchasePrice').value);
                if (isNaN(newHolding.quantity) || isNaN(newHolding.price) || !newHolding.date) { alert("Please fill in all details for a quantity-based holding."); return; }
                newHolding.dollarValue = newHolding.quantity * newHolding.price;
            } else {
                newHolding.dollarValue = parseFloat(document.getElementById('purchaseValue').value);
                if (isNaN(newHolding.dollarValue) || !newHolding.date) { alert("Please fill in dollar value and date for a value-based holding."); return; }
            }
        }
        if (portfolio.find(item => item.symbol === newHolding.symbol)) { alert(`${newHolding.symbol} is already in your portfolio.`); return; }
        const response = await fetch('/api/portfolio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newHolding) });
        if (response.ok) {
            const addedHolding = await response.json();
            portfolio.push(addedHolding);
            renderPortfolioList();
            renderPortfolioSummary();
            renderPortfolioChart();
            alert(`${newHolding.symbol} has been added to your portfolio.`);
        } else {
            alert("Failed to add holding to the database.");
        }
    }

    async function removePortfolioItem(event) {
        const holdingId = event.target.dataset.id;
        const response = await fetch(`/api/portfolio/${holdingId}`, { method: 'DELETE' });
        if (response.ok) {
            portfolio = portfolio.filter(p => p.id != holdingId);
            renderPortfolioList();
            renderPortfolioSummary();
            renderPortfolioChart();
        } else {
            alert("Failed to remove holding.");
        }
    }

    // --- CHARTING & UI TEMPLATES ---
    function getStockDataViewHtml() {
        return `
            <div class="card mb-6">
                <div class="flex justify-between items-center">
                    <div><h2 id="stockName" class="text-3xl font-bold"></h2><p id="stockSymbol" class="text-lg text-gray-400"></p></div>
                    <div class="text-right"><p id="currentPrice" class="text-4xl font-bold"></p></div>
                </div>
            </div>
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div class="lg-col-span-2 card">
                    <div id="dateRangeDisplay" class="text-center text-gray-400 font-medium mb-4"></div>
                    <div class="chart-container" style="height: 400px;"><canvas id="stockChart"></canvas></div>
                    <div class="mt-8">
                        <p class="text-center text-sm text-gray-500 mb-2">Timeline Navigator</p>
                        <div id="timelineContainer" style="height: 100px;"><canvas id="timelineChart"></canvas></div>
                    </div>
                </div>
                <div class="card space-y-4">
                    <h3 class="text-xl font-bold mb-2">Key Statistics</h3>
                    <div class="kpi-grid">
                        <div><p class="kpi-label">Day High</p><p id="dayHigh" class="kpi-value"></p></div>
                        <div><p class="kpi-label">Day Low</p><p id="dayLow" class="kpi-value"></p></div>
                        <div><p class="kpi-label">52-Wk High</p><p id="fiftyTwoWeekHigh" class="kpi-value"></p></div>
                        <div><p class="kpi-label">52-Wk Low</p><p id="fiftyTwoWeekLow" class="kpi-value"></p></div>
                        <div><p class="kpi-label">Market Cap</p><p id="marketCap" class="kpi-value"></p></div>
                        <div><p class="kpi-label">Volume</p><p id="volume" class="kpi-value"></p></div>
                        <div><p class="kpi-label">P/E Ratio</p><p id="forwardPE" class="kpi-value"></p></div>
                    </div>
                    <div id="addToPortfolioSection" class="pt-4 border-t border-gray-700">
                        <h4 class="font-semibold mb-2">Add <span id="portfolioTicker"></span> to Portfolio</h4>
                        <div class="flex items-center mb-3">
                            <input id="isRealCheckbox" type="checkbox" class="h-4 w-4 rounded border-gray-600 text-cyan-600 focus:ring-cyan-500 bg-gray-700">
                            <label for="isRealCheckbox" class="ml-2 block text-sm text-gray-300">This is a real holding</label>
                        </div>
                        <div id="realPurchaseInputs" class="space-y-3 hidden">
                            <div class="flex items-center space-x-4 mb-2">
                                <label class="flex items-center text-sm cursor-pointer"><input type="radio" name="purchaseType" value="quantity" class="form-radio" checked><span class="ml-2">By Quantity</span></label>
                                <label class="flex items-center text-sm cursor-pointer"><input type="radio" name="purchaseType" value="value" class="form-radio"><span class="ml-2">By Value</span></label>
                            </div>
                            <div id="quantityInputs" class="space-y-3"><input type="number" id="purchaseQuantity" placeholder="Quantity (e.g., 10)" class="form-input"><input type="number" id="purchasePrice" placeholder="Price per Share" class="form-input"></div>
                            <div id="valueInputs" class="space-y-3 hidden"><input type="number" id="purchaseValue" placeholder="Total Dollar Value (e.g., 500)" class="form-input"></div>
                            <input type="date" id="purchaseDate" class="form-input mt-3">
                        </div>
                        <button id="addToPortfolioBtn" class="button-success w-full mt-3">Add to Portfolio</button>
                    </div>
                </div>
            </div>
        `;
    }

    function setupIndividualStockChart(historicalData) {
        if (stockChart) stockChart.destroy();
        if (timelineChart) timelineChart.destroy();
        const stockData = historicalData.map(d => ({ date: d.Date, price: d.Close }));
        Chart.defaults.color = '#E5E7EB';
        Chart.defaults.font.family = "'Inter', sans-serif";
        const mainCtx = document.getElementById('stockChart').getContext('2d');
        stockChart = new Chart(mainCtx, createChartConfig('Stock Price (USD)'));
        const timelineCtx = document.getElementById('timelineChart').getContext('2d');
        timelineChart = new Chart(timelineCtx, createTimelineConfig(stockData));
        addTimelineInteraction(document.getElementById('timelineChart'), timelineChart, stockChart, stockData);
        updateMainChart(timelineChart, stockChart);
    }

    function addTimelineInteraction(canvas, timeline, mainChart, data) {
        let isDragging = false, isResizingStart = false, isResizingEnd = false;
        let dragStartX = 0, initialStartIndex = 0, initialEndIndex = 0;
        const getIndexFromX = (x) => {
            const { left, right } = timeline.chartArea;
            const index = Math.round((x - left) / (right - left) * (data.length - 1));
            return Math.max(0, Math.min(data.length - 1, index));
        };
        canvas.addEventListener('mousedown', (e) => {
            const x = e.offsetX;
            const meta = timeline.getDatasetMeta(0);
            const { startIndex, endIndex } = timeline.options.plugins.brush;
            const startX = meta.data[startIndex].x, endX = meta.data[endIndex].x;
            if (x >= startX - 8 && x <= startX + 8) isResizingStart = true;
            else if (x >= endX - 8 && x <= endX + 8) isResizingEnd = true;
            else if (x > startX && x < endX) {
                isDragging = true;
                dragStartX = x;
                initialStartIndex = startIndex;
                initialEndIndex = endIndex;
            }
        });
        window.addEventListener('mousemove', (e) => {
            if (!isDragging && !isResizingStart && !isResizingEnd) return;
            const x = e.clientX - canvas.getBoundingClientRect().left;
            let { startIndex, endIndex } = timeline.options.plugins.brush;
            const newIndex = getIndexFromX(x);
            if (isResizingStart) { if (newIndex < endIndex) timeline.options.plugins.brush.startIndex = newIndex; }
            else if (isResizingEnd) { if (newIndex > startIndex) timeline.options.plugins.brush.endIndex = newIndex; }
            else if (isDragging) {
                const diff = newIndex - getIndexFromX(dragStartX);
                let newStartIndex = initialStartIndex + diff;
                let newEndIndex = initialEndIndex + diff;
                if (newStartIndex >= 0 && newEndIndex < data.length) {
                    timeline.options.plugins.brush.startIndex = newStartIndex;
                    timeline.options.plugins.brush.endIndex = newEndIndex;
                }
            }
            timeline.update('none');
            updateMainChart(timeline, mainChart);
        });
        window.addEventListener('mouseup', () => isDragging = isResizingStart = isResizingEnd = false);
    }

    function updateMainChart(timeline, mainChart) {
        const { startIndex, endIndex } = timeline.options.plugins.brush;
        const slicedData = timeline.data.datasets[0].data.slice(startIndex, endIndex + 1);
        const slicedLabels = timeline.data.labels.slice(startIndex, endIndex + 1);
        mainChart.data.labels = slicedLabels;
        mainChart.data.datasets[0].data = slicedData;
        mainChart.update('none');
        document.getElementById('dateRangeDisplay').textContent = `${slicedLabels[0]} to ${slicedLabels[slicedLabels.length - 1]}`;
    }
    
    async function renderPortfolioChart() {
        const portfolioCtx = document.getElementById('portfolioChart')?.getContext('2d');
        const returnEl = document.getElementById('portfolioTotalReturn');
        if (!portfolioCtx) return;
        const chartContainer = portfolioCtx.parentElement;

        try {
            const realHoldings = portfolio.filter(p => p.isReal);
            const trackingHoldings = portfolio.filter(p => !p.isReal);
            let holdingsForCalc, isWeighted;
            if (realHoldings.length > 0) {
                holdingsForCalc = realHoldings; isWeighted = true;
            } else if (trackingHoldings.length > 0) {
                holdingsForCalc = trackingHoldings; isWeighted = false;
            } else {
                if (portfolioChart) portfolioChart.destroy();
                if(returnEl) returnEl.textContent = 'No holdings to display.';
                return;
            }
            const tickers = holdingsForCalc.map(p => p.symbol);
            const response = await fetch('/api/portfolio_data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tickers })
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({ error: 'Failed to fetch portfolio data' }));
                throw new Error(err.error);
            }
            const data = await response.json();
            const dates = Object.keys(data);
            if (dates.length === 0) throw new Error("No historical data returned for portfolio.");
            const normalizedData = {};
            tickers.forEach(ticker => {
                if(data[dates[0]][ticker]) {
                    const firstPrice = data[dates[0]][ticker];
                    normalizedData[ticker] = dates.map(date => ((data[date][ticker] - firstPrice) / firstPrice) * 100);
                }
            });
            let portfolioPerformance;
            if (isWeighted) {
                const totalInvestment = holdingsForCalc.reduce((sum, h) => sum + h.dollarValue, 0);
                const weights = {};
                holdingsForCalc.forEach(h => { weights[h.symbol] = h.dollarValue / totalInvestment; });
                portfolioPerformance = dates.map((_, i) => {
                    let weightedSum = 0;
                    holdingsForCalc.forEach(h => { if (normalizedData[h.symbol]) weightedSum += normalizedData[h.symbol][i] * weights[h.symbol]; });
                    return weightedSum;
                });
            } else {
                portfolioPerformance = dates.map((_, i) => {
                    let sum = 0, count = 0;
                    holdingsForCalc.forEach(h => { if(normalizedData[h.symbol]) { sum += normalizedData[h.symbol][i]; count++; } });
                    return count > 0 ? sum / count : 0;
                });
            }
            if (portfolioChart) portfolioChart.destroy();
            if (chartContainer.querySelector('canvas') === null) {
                chartContainer.innerHTML = '<canvas id="portfolioChart"></canvas>';
            }
            const newCtx = document.getElementById('portfolioChart').getContext('2d');
            portfolioChart = new Chart(newCtx, createChartConfig('Portfolio Performance (%)'));
            portfolioChart.allData = { labels: dates, data: portfolioPerformance };
            handleTimeframeChange({ target: document.querySelector('.timeframe-btn.active') });
        } catch (error) {
            console.error("Error rendering portfolio chart:", error);
            if (portfolioChart) portfolioChart.destroy();
            if (chartContainer) chartContainer.innerHTML = `<div class="text-red-400 text-center mt-10"><p class="font-bold">Error</p><p>${error.message}</p></div>`;
            if(returnEl) returnEl.textContent = '-';
        }
    }

    function handleTimeframeChange(event) {
        const button = event.target;
        document.querySelectorAll('.timeframe-btn').forEach(btn => btn.classList.remove('active'));
        button.classList.add('active');
        if (!portfolioChart || !portfolioChart.allData) return;
        const range = button.dataset.range;
        const { labels, data } = portfolioChart.allData;
        const days = { '1M': 21, '3M': 63, '6M': 126, '1Y': 252, '5Y': 1260 };
        let slicedLabels = labels;
        let slicedData = data;
        if (range !== 'ALL' && days[range] < labels.length) {
            slicedLabels = labels.slice(-days[range]);
            slicedData = data.slice(-days[range]);
        }
        portfolioChart.data.labels = slicedLabels;
        portfolioChart.data.datasets[0].data = slicedData;
        portfolioChart.update();
        const totalReturn = slicedData.length > 1 ? slicedData[slicedData.length - 1] - slicedData[0] : 0;
        const returnEl = document.getElementById('portfolioTotalReturn');
        returnEl.textContent = `${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`;
        returnEl.style.color = totalReturn >= 0 ? '#34D399' : '#F87171';
    }

    function createChartConfig(label) {
        return {
            type: 'line',
            data: { labels: [], datasets: [{ label: label, data: [], borderColor: '#22D3EE', backgroundColor: 'rgba(34, 211, 238, 0.1)', fill: true, tension: 0.2, pointRadius: 0 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false, callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` } } },
                scales: {
                    y: { grid: { color: 'rgba(255, 255, 255, 0.1)' }, ticks: { color: '#9CA3AF' } },
                    x: { grid: { display: false }, ticks: { color: '#9CA3AF', maxRotation: 0, autoSkip: true, maxTicksLimit: 7 } }
                }
            }
        };
    }

    function createTimelineConfig(stockData) {
        const brushPlugin = {
            id: 'brush',
            afterDraw: (chart) => {
                const { ctx, chartArea: { left, top, right, bottom } } = chart;
                if (!chart.getDatasetMeta(0).data.length) return;
                const { startIndex, endIndex } = chart.options.plugins.brush;
                const startX = chart.getDatasetMeta(0).data[startIndex].x;
                const endX = chart.getDatasetMeta(0).data[endIndex].x;
                ctx.save();
                ctx.fillStyle = 'rgba(100, 116, 139, 0.3)';
                ctx.fillRect(left, top, startX - left, bottom - top);
                ctx.fillRect(endX, top, right - endX, bottom - top);
                ctx.lineWidth = 1; ctx.strokeStyle = '#22D3EE';
                ctx.strokeRect(startX, top, endX - startX, bottom - top);
                ctx.restore();
            }
        };
        return {
            type: 'line',
            data: { labels: stockData.map(d => d.date), datasets: [{ data: stockData.map(d => d.price), borderColor: '#475569', fill: false, pointRadius: 0, borderWidth: 1 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { enabled: false }, brush: { startIndex: Math.max(0, stockData.length - 252), endIndex: stockData.length - 1 } },
                scales: { y: { display: false }, x: { display: false } }
            },
            plugins: [brushPlugin]
        };
    }
});
