// static/script.js
document.addEventListener('DOMContentLoaded', () => {
    // --- GLOBAL STATE ---
    let stockChart, timelineChart;
    let currentStockData = null;
    let portfolio = [];
    let currentUser = null;

    // --- INITIALIZATION ---
    function initialize() {
        document.getElementById('loginForm')?.addEventListener('submit', handleLogin);
        document.getElementById('logoutBtn')?.addEventListener('click', handleLogout);
        checkSession();
    }

    // --- AUTHENTICATION & SESSION MANAGEMENT ---
    async function checkSession() {
        try {
            const response = await fetch('/api/session');
            if (!response.ok) throw new Error('No active session');
            currentUser = await response.json();
            showDashboard();
        } catch (error) {
            showLogin();
        }
    }

    async function handleLogin(e) {
        e.preventDefault();
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        const errorDiv = document.getElementById('loginError');
        errorDiv.classList.add('hidden');

        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Login failed');
            }
            currentUser = await response.json();
            showDashboard();
        } catch (error) {
            errorDiv.textContent = error.message;
            errorDiv.classList.remove('hidden');
        }
    }

    async function handleLogout() {
        await fetch('/api/logout', { method: 'POST' });
        currentUser = null;
        portfolio = [];
        showLogin();
    }

    function showLogin() {
        document.getElementById('loginScreen').classList.remove('hidden');
        document.getElementById('dashboardScreen').classList.add('hidden');
    }

    async function showDashboard() {
        document.getElementById('loginScreen').classList.add('hidden');
        document.getElementById('dashboardScreen').classList.remove('hidden');
        
        setupUIAccess();
        initializeDashboardEventListeners();

        await fetchPortfolio();
        
        document.querySelector('.nav-link[data-tab="home"]').click();
    }

    // --- UI & ACCESS CONTROL ---
    function setupUIAccess() {
        if (!currentUser) return;
        const roles = { guest: 0, member: 1, admin: 2 };
        const userLevel = roles[currentUser.role];

        document.querySelectorAll('[data-role]').forEach(el => {
            const requiredLevel = roles[el.dataset.role];
            el.style.display = userLevel >= requiredLevel ? 'flex' : 'none';
        });

        const userInfoEl = document.getElementById('userInfo');
        userInfoEl.innerHTML = `Logged in as: <strong class="font-bold">${currentUser.username}</strong><br>Role: <span class="capitalize">${currentUser.role}</span>`;
    }

    // --- DASHBOARD INITIALIZATION ---
    function initializeDashboardEventListeners() {
        document.getElementById('fetchBtn')?.addEventListener('click', fetchStockData);
        document.getElementById('tickerInput')?.addEventListener('keypress', e => e.key === 'Enter' && fetchStockData());
        document.getElementById('presentationForm')?.addEventListener('submit', handlePresentationSubmit);

        // Add event listeners to navigation links
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const tab = link.dataset.tab;

                document.querySelectorAll('.nav-link').forEach(lnk => lnk.classList.remove('active'));
                link.classList.add('active');

                document.querySelectorAll('.tab-content').forEach(content => {
                    content.classList.add('hidden');
                    if (content.id === `${tab}Content`) content.classList.remove('hidden');
                });
                
                switch (tab) {
                    case 'home': renderPortfolioSummary(); break;
                    case 'portfolio': renderPortfolioDashboard(); break;
                    case 'transactions': renderTransactionHistory(); break;
                    case 'presentations': renderPresentations(); break;
                    case 'about': break; // No dynamic content needed
                    case 'admin': break; // No dynamic content needed
                }
            });
        });
    }
    
    // --- STOCK SEARCH ---
    function fetchStockData() {
        const ticker = document.getElementById('tickerInput').value.trim().toUpperCase();
        if (!ticker) return;
        
        const homeDashboard = document.getElementById('homeDashboard');
        const stockDataView = document.getElementById('stockDataView');
        homeDashboard.innerHTML = '<p class="text-center card">Loading...</p>';
        stockDataView.classList.add('hidden');

        fetch(`/api/stock/${ticker}`)
            .then(response => response.ok ? response.json() : response.json().then(err => { throw new Error(err.error) }))
            .then(data => {
                currentStockData = data;
                homeDashboard.classList.add('hidden');
                stockDataView.innerHTML = getStockDataViewHtml();
                stockDataView.classList.remove('hidden');
                updateStockInfoUI(data);
                setupIndividualStockChart(data.historical);
                
                const addToPortfolioSection = document.getElementById('addToPortfolioSection');
                if (currentUser.role === 'admin') {
                    addToPortfolioSection.style.display = 'block';
                    document.getElementById('isRealCheckbox').addEventListener('change', toggleRealPurchaseInputs);
                    document.getElementById('addToPortfolioBtn').addEventListener('click', addStockToPortfolio);
                    document.querySelectorAll('input[name="purchaseType"]').forEach(radio => radio.addEventListener('change', togglePurchaseTypeInputs));
                    document.getElementById('portfolioTicker').textContent = data.symbol;
                } else {
                    addToPortfolioSection.style.display = 'none';
                }
            })
            .catch(error => {
                homeDashboard.innerHTML = `<p class="text-red-400 text-center card">Error: ${error.message}</p>`;
                homeDashboard.classList.remove('hidden');
                stockDataView.classList.add('hidden');
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
        if (currentUser.role === 'guest') {
            portfolio = [];
            return;
        }
        try {
            const response = await fetch('/api/portfolio');
            if (!response.ok) throw new Error('Failed to fetch portfolio');
            portfolio = await response.json();
        } catch (error) {
            console.error("Fetch portfolio error:", error);
            portfolio = [];
        }
    }

    async function addStockToPortfolio() {
        if (!currentStockData || currentUser.role !== 'admin') return;
        const isReal = document.getElementById('isRealCheckbox').checked;
        
        const newHolding = {
            symbol: currentStockData.symbol, longName: currentStockData.longName,
            isReal: isReal, price: currentStockData.currentPrice
        };

        if (isReal) {
            const purchaseType = document.querySelector('input[name="purchaseType"]:checked').value;
            newHolding.purchaseType = purchaseType;
            newHolding.date = document.getElementById('purchaseDate').value;
            if (purchaseType === 'quantity') {
                newHolding.quantity = parseFloat(document.getElementById('purchaseQuantity').value);
                newHolding.price = parseFloat(document.getElementById('purchasePrice').value);
                if (isNaN(newHolding.quantity) || isNaN(newHolding.price) || !newHolding.date) { alert("Please fill in all purchase details."); return; }
                newHolding.dollarValue = newHolding.quantity * newHolding.price;
            } else {
                newHolding.dollarValue = parseFloat(document.getElementById('purchaseValue').value);
                if (isNaN(newHolding.dollarValue) || !newHolding.date) { alert("Please fill in dollar value and date."); return; }
            }
        }

        const response = await fetch('/api/portfolio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newHolding) });
        if (response.ok) {
            const addedHolding = await response.json();
            portfolio.push(addedHolding);
            alert(`${newHolding.symbol} has been added.`);
            document.querySelector('.nav-link[data-tab="portfolio"]').click();
        } else {
            alert("Failed to add holding.");
        }
    }
    
    // --- RENDER FUNCTIONS FOR EACH TAB ---
    async function renderPortfolioSummary() {
        const homeDashboard = document.getElementById('homeDashboard');
        const welcomeMessageHTML = `<div class="card text-center transition-all duration-500"><h2 class="text-2xl font-bold mb-2">Welcome, ${currentUser.username}!</h2><p>Search for a stock to get started, or check out the other tabs.</p></div>`;
        
        if (currentUser.role === 'guest') {
            homeDashboard.innerHTML = welcomeMessageHTML;
            return;
        }

        homeDashboard.innerHTML = `<div id="portfolioSummary"><h3 class="text-2xl font-bold mb-4">Portfolio Snapshot</h3><div id="portfolioSummaryList" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"></div></div>`;
        const summaryList = document.getElementById('portfolioSummaryList');
        if (portfolio.length === 0) {
            summaryList.innerHTML = '<p class="col-span-full text-center text-gray-500 card">No holdings in portfolio yet.</p>';
            return;
        }

        summaryList.innerHTML = '<p class="col-span-full text-center">Loading live prices...</p>';
        try {
            const tickers = [...new Set(portfolio.map(p => p.symbol))];
            const response = await fetch('/api/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tickers }) });
            if (!response.ok) throw new Error('Failed to fetch quotes');
            
            const quotes = await response.json();
            summaryList.innerHTML = '';
            portfolio.forEach(holding => {
                const quote = quotes[holding.symbol];
                const currentPrice = quote ? quote.currentPrice : holding.price;
                const prevClose = quote ? quote.previousClose : holding.price;
                const priceChange = currentPrice - prevClose;
                const priceChangePercent = prevClose > 0 ? (priceChange / prevClose) * 100 : 0;
                const changeColor = priceChange >= 0 ? 'text-green-400' : 'text-red-400';
                
                const card = document.createElement('div');
                card.className = 'summary-card';
                card.innerHTML = `<div class="flex justify-between items-center"><p class="font-bold text-lg">${holding.symbol}</p><p class="font-semibold text-lg">${currentPrice ? '$' + currentPrice.toFixed(2) : 'N/A'}</p></div><p class="text-sm text-gray-400 truncate">${holding.longName}</p><div class="text-right mt-2 ${changeColor}"><span class="font-medium">${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}</span><span>(${priceChangePercent.toFixed(2)}%)</span></div>`;
                summaryList.appendChild(card);
            });
        } catch (error) {
            summaryList.innerHTML = '<p class="text-red-400 col-span-full text-center">Could not load live prices.</p>';
        }
    }

    function renderTransactionHistory() {
        const listEl = document.getElementById('transactionList');
        listEl.innerHTML = '';
        if (portfolio.length === 0) {
            listEl.innerHTML = '<tr><td colspan="7" class="text-center p-4 text-gray-500">No transactions yet.</td></tr>';
            return;
        }
        portfolio.forEach(item => {
            const row = document.createElement('tr');
            row.className = 'border-b border-gray-800 hover:bg-gray-800';
            
            // FIX: Use more robust checks for null/undefined before calling .toFixed()
            const quantityText = item.quantity != null ? `${item.quantity.toFixed(4)} shares` : 'N/A';
            const dollarValueText = item.dollarValue != null ? `$${item.dollarValue.toFixed(2)}` : 'N/A';
            const priceText = item.price != null ? `$${item.price.toFixed(2)}` : 'N/A';
            
            const purchaseDetail = item.purchaseType === 'quantity' ? quantityText : (item.purchaseType === 'value' ? dollarValueText : 'N/A');

            row.innerHTML = `
                <td class="p-3">${item.date || 'N/A'}</td>
                <td class="p-3 font-bold">${item.symbol}</td>
                <td class="p-3">${item.longName}</td>
                <td class="p-3">${item.isReal ? 'Buy' : 'Track'}</td>
                <td class="p-3 text-right">${purchaseDetail}</td>
                <td class="p-3 text-right">${priceText}</td>
                <td class="p-3 text-right font-semibold">${dollarValueText}</td>
            `;
            listEl.appendChild(row);
        });
    }

    async function renderPresentations() {
        const listEl = document.getElementById('presentationList');
        const formContainer = document.getElementById('presentationFormContainer');
        formContainer.style.display = currentUser.role !== 'guest' ? '' : 'none';
        listEl.innerHTML = '<p class="card">Loading presentations...</p>';
        try {
            const response = await fetch('/api/presentations');
            const presentations = await response.json();
            listEl.innerHTML = '';
            if (presentations.length === 0) {
                listEl.innerHTML = '<p class="card text-gray-500">No presentations have been submitted yet.</p>';
                return;
            }
            presentations.forEach(p => {
                const card = document.createElement('div');
                card.className = 'card';
                const actionColor = p.action === 'Buy' ? 'text-green-400' : 'text-red-400';
                const voteButtons = currentUser.role !== 'guest' ? `<button class="vote-btn" data-id="${p.id}" data-type="for"><i class="fas fa-thumbs-up text-green-500"></i><span class="ml-2">${p.votesFor}</span></button><button class="vote-btn" data-id="${p.id}" data-type="against"><i class="fas fa-thumbs-down text-red-500"></i><span class="ml-2">${p.votesAgainst}</span></button>` : `<span class="text-sm text-gray-500">Login as member to vote</span>`;
                card.innerHTML = `<h4 class="text-xl font-bold">${p.title}</h4><p class="text-sm text-gray-400 mb-3">Proposing to <span class="font-bold ${actionColor}">${p.action} ${p.ticker}</span></p><a href="${p.url}" target="_blank" rel="noopener noreferrer" class="text-cyan-400 hover:underline mb-4 block">View Presentation</a><div class="flex items-center justify-end space-x-4">${voteButtons}</div>`;
                listEl.appendChild(card);
            });
            if (currentUser.role !== 'guest') listEl.querySelectorAll('.vote-btn').forEach(btn => btn.addEventListener('click', handleVote));
        } catch (error) {
            listEl.innerHTML = '<p class="card text-red-400">Could not load presentations.</p>';
        }
    }

    async function renderPortfolioDashboard() {
        const realHoldings = portfolio.filter(p => p.isReal);
        if (realHoldings.length === 0) {
            document.getElementById('sectorBreakdown').innerHTML = '<p class="card text-center text-gray-500">No real holdings to analyze.</p>';
            document.getElementById('portfolioTotalValue').textContent = '$0.00';
            document.getElementById('portfolioTotalCost').textContent = '$0.00';
            document.getElementById('portfolioTotalEarnings').textContent = '$0.00';
            return;
        }
        const tickers = [...new Set(realHoldings.map(p => p.symbol))];
        const response = await fetch('/api/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tickers }) });
        const quotes = await response.json();
        let totalCurrentValue = 0, totalCost = 0;
        const sectors = {};
        realHoldings.forEach(h => {
            // FIX: Default null quantity/dollarValue to 0 for calculations
            const quantity = h.quantity || 0;
            const dollarValue = h.dollarValue || 0;
            
            const currentPrice = quotes[h.symbol]?.currentPrice || h.price || 0;
            const currentValue = quantity * currentPrice;
            const sectorName = h.sector || 'Other';

            if (!sectors[sectorName]) sectors[sectorName] = { holdings: [], totalCost: 0, currentValue: 0 };
            
            sectors[sectorName].holdings.push({ ...h, currentValue });
            sectors[sectorName].totalCost += dollarValue;
            sectors[sectorName].currentValue += currentValue;
            
            totalCurrentValue += currentValue;
            totalCost += dollarValue;
        });
        const totalEarnings = totalCurrentValue - totalCost;
        const earningsColor = totalEarnings >= 0 ? 'text-green-400' : 'text-red-400';
        document.getElementById('portfolioTotalValue').textContent = `$${totalCurrentValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        document.getElementById('portfolioTotalCost').textContent = `$${totalCost.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        const earningsEl = document.getElementById('portfolioTotalEarnings');
        earningsEl.textContent = `${totalEarnings >= 0 ? '+' : '-'}$${Math.abs(totalEarnings).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        earningsEl.className = `text-3xl font-bold mt-2 ${earningsColor}`;
        const breakdownEl = document.getElementById('sectorBreakdown');
        breakdownEl.innerHTML = '';
        Object.keys(sectors).sort().forEach(sectorName => {
            const sector = sectors[sectorName];
            const sectorEarnings = sector.currentValue - sector.totalCost;
            const sectorEarningsColor = sectorEarnings >= 0 ? 'text-green-400' : 'text-red-400';
            const sectorCard = document.createElement('div');
            sectorCard.className = 'card';
            sectorCard.innerHTML = `<h4 class="text-xl font-bold mb-4">${sectorName}</h4><div class="grid grid-cols-3 gap-4 mb-4 text-center"><div><p class="text-sm text-gray-400">Invested</p><p class="font-semibold">$${sector.totalCost.toFixed(2)}</p></div><div><p class="text-sm text-gray-400">Current Value</p><p class="font-semibold">$${sector.currentValue.toFixed(2)}</p></div><div><p class="text-sm text-gray-400">Earnings</p><p class="font-semibold ${sectorEarningsColor}">${sectorEarnings >= 0 ? '+' : '-'}$${Math.abs(sectorEarnings).toFixed(2)}</p></div></div><table class="w-full text-sm"><thead><tr class="border-b border-gray-700"><th class="p-2 text-left">Symbol</th><th class="p-2 text-right">Qty</th><th class="p-2 text-right">Cost</th><th class="p-2 text-right">Value</th></tr></thead><tbody>${sector.holdings.map(h => `<tr class="border-b border-gray-800"><td class="p-2 font-bold">${h.symbol}</td><td class="p-2 text-right">${(h.quantity || 0).toFixed(2)}</td><td class="p-2 text-right">$${(h.dollarValue || 0).toFixed(2)}</td><td class="p-2 text-right">$${(h.currentValue || 0).toFixed(2)}</td></tr>`).join('')}</tbody></table>`;
            breakdownEl.appendChild(sectorCard);
        });
    }

    // --- EVENT HANDLERS ---
    async function handlePresentationSubmit(e) {
        e.preventDefault();
        const form = e.target;
        const presentation = { title: form.querySelector('#presentationTitle').value, url: form.querySelector('#presentationUrl').value, ticker: form.querySelector('#presentationTicker').value, action: form.querySelector('input[name="presentationAction"]:checked').value };
        const response = await fetch('/api/presentations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(presentation) });
        if (response.ok) { form.reset(); renderPresentations(); } else alert('Failed to submit presentation.');
    }
    async function handleVote(e) {
        const button = e.currentTarget;
        const id = button.dataset.id;
        const voteType = button.dataset.type;
        const response = await fetch(`/api/presentations/${id}/vote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voteType }) });
        if (response.ok) renderPresentations(); else alert('Failed to record vote.');
    }
    function toggleRealPurchaseInputs() { document.getElementById('realPurchaseInputs').classList.toggle('hidden', !this.checked); }
    function togglePurchaseTypeInputs() {
        const purchaseType = document.querySelector('input[name="purchaseType"]:checked').value;
        document.getElementById('quantityInputs').classList.toggle('hidden', purchaseType !== 'quantity');
        document.getElementById('valueInputs').classList.toggle('hidden', purchaseType === 'quantity');
    }

    // --- CHARTING & UI TEMPLATES (UNCHANGED) ---
    function getStockDataViewHtml(){return`<div class="card mb-6"><div class="flex justify-between items-center"><div><h2 id="stockName" class="text-3xl font-bold"></h2><p id="stockSymbol" class="text-lg text-gray-400"></p></div><div class="text-right"><p id="currentPrice" class="text-4xl font-bold"></p></div></div></div><div class="grid grid-cols-1 lg:grid-cols-3 gap-6"><div class="lg:col-span-2 card"><div id="dateRangeDisplay" class="text-center text-gray-400 font-medium mb-4"></div><div class="chart-container" style="height: 400px;"><canvas id="stockChart"></canvas></div><div class="mt-8"><p class="text-center text-sm text-gray-500 mb-2">Timeline Navigator</p><div id="timelineContainer" style="height: 100px;"><canvas id="timelineChart"></canvas></div></div></div><div class="card space-y-4"><h3 class="text-xl font-bold mb-2">Key Statistics</h3><div class="kpi-grid"><div><p class="kpi-label">Day High</p><p id="dayHigh" class="kpi-value"></p></div><div><p class="kpi-label">Day Low</p><p id="dayLow" class="kpi-value"></p></div><div><p class="kpi-label">52-Wk High</p><p id="fiftyTwoWeekHigh" class="kpi-value"></p></div><div><p class="kpi-label">52-Wk Low</p><p id="fiftyTwoWeekLow" class="kpi-value"></p></div><div><p class="kpi-label">Market Cap</p><p id="marketCap" class="kpi-value"></p></div><div><p class="kpi-label">Volume</p><p id="volume" class="kpi-value"></p></div><div><p class="kpi-label">P/E Ratio</p><p id="forwardPE" class="kpi-value"></p></div></div><div id="addToPortfolioSection" class="pt-4 border-t border-gray-700"><h4 class="font-semibold mb-2">Add <span id="portfolioTicker"></span> to Portfolio</h4><div class="flex items-center mb-3"><input id="isRealCheckbox" type="checkbox" class="h-4 w-4 rounded border-gray-600 text-cyan-600 focus:ring-cyan-500 bg-gray-700"><label for="isRealCheckbox" class="ml-2 block text-sm text-gray-300">This is a real holding</label></div><div id="realPurchaseInputs" class="space-y-3 hidden"><div class="flex items-center space-x-4 mb-2"><label class="flex items-center text-sm cursor-pointer"><input type="radio" name="purchaseType" value="quantity" class="form-radio" checked><span class="ml-2">By Quantity</span></label><label class="flex items-center text-sm cursor-pointer"><input type="radio" name="purchaseType" value="value" class="form-radio"><span class="ml-2">By Value</span></label></div><div id="quantityInputs" class="space-y-3"><input type="number" step="any" id="purchaseQuantity" placeholder="Quantity (e.g., 10)" class="form-input"><input type="number" step="any" id="purchasePrice" placeholder="Price per Share" class="form-input"></div><div id="valueInputs" class="space-y-3 hidden"><input type="number" step="any" id="purchaseValue" placeholder="Total Dollar Value (e.g., 500)" class="form-input"></div><input type="date" id="purchaseDate" class="form-input mt-3"></div><button id="addToPortfolioBtn" class="button-success w-full mt-3">Add to Portfolio</button></div></div></div>`;}
    function setupIndividualStockChart(h){if(stockChart)stockChart.destroy();if(timelineChart)timelineChart.destroy();if(!h||h.length===0)return;const s=h.map(d=>({date:d.Date,price:d.Close}));Chart.defaults.color="#E5E7EB";Chart.defaults.font.family="'Inter', sans-serif";const m=document.getElementById("stockChart").getContext("2d");stockChart=new Chart(m,createChartConfig("Stock Price (USD)"));const t=document.getElementById("timelineChart").getContext("2d");timelineChart=new Chart(t,createTimelineConfig(s));addTimelineInteraction(document.getElementById("timelineChart"),timelineChart,stockChart,s);updateMainChart(timelineChart,stockChart)}
    function addTimelineInteraction(c,t,m,d){let i=!1,s=!1,e=!1,a=0,n=0,l=0;const r=x=>{const{left:L,right:R}=t.chartArea;return Math.max(0,Math.min(d.length-1,Math.round((x-L)/(R-L)*(d.length-1))))};c.addEventListener("mousedown",o=>{if(!t.getDatasetMeta(0).data.length)return;const g=o.offsetX,p=t.getDatasetMeta(0),{startIndex:u,endIndex:h}=t.options.plugins.brush,f=p.data[u].x,y=p.data[h].x;g>=f-8&&g<=f+8?s=!0:g>=y-8&&g<=y+8?e=!0:g>f&&g<y&&(i=!0,a=g,n=u,l=h)});window.addEventListener("mousemove",o=>{if(!i&&!s&&!e)return;const g=o.clientX-c.getBoundingClientRect().left;let{startIndex:p,endIndex:u}=t.options.plugins.brush;const h=r(g);if(s){if(h<u)t.options.plugins.brush.startIndex=h}else if(e){if(h>p)t.options.plugins.brush.endIndex=h}else if(i){const f=h-r(a);let y=n+f,k=l+f;y>=0&&k<d.length&&(t.options.plugins.brush.startIndex=y,t.options.plugins.brush.endIndex=k)}t.update("none");updateMainChart(t,m)});window.addEventListener("mouseup",()=>i=s=e=!1)}
    function updateMainChart(t,m){const{startIndex:s,endIndex:e}=t.options.plugins.brush,a=t.data.datasets[0].data.slice(s,e+1),n=t.data.labels.slice(s,e+1);m.data.labels=n;m.data.datasets[0].data=a;m.update("none");const l=document.getElementById("dateRangeDisplay");l&&(l.textContent=n&&n.length>0?`${n[0]} to ${n[n.length-1]}`:"No date range available.")}
    function createChartConfig(l){return{type:"line",data:{labels:[],datasets:[{label:l,data:[],borderColor:"#22D3EE",backgroundColor:"rgba(34, 211, 238, 0.1)",fill:!0,tension:.2,pointRadius:0}]},options:{responsive:!0,maintainAspectRatio:!1,plugins:{legend:{display:!1},tooltip:{mode:"index",intersect:!1,callbacks:{label:c=>`${c.dataset.label}: ${c.parsed.y.toLocaleString(void 0,{minimumFractionDigits:2,maximumFractionDigits:2})}`}}},scales:{y:{grid:{color:"rgba(255, 255, 255, 0.1)"},ticks:{color:"#9CA3AF"}},x:{grid:{display:!1},ticks:{color:"#9CA3AF",maxRotation:0,autoSkip:!0,maxTicksLimit:7}}}}}}
    function createTimelineConfig(s){const e={id:"brush",afterDraw:c=>{if(!c.getDatasetMeta(0).data.length)return;const{ctx:t,chartArea:{left:m,top:d,right:a,bottom:n}}=c,{startIndex:l,endIndex:r}=c.options.plugins.brush,o=c.getDatasetMeta(0).data[l].x,g=c.getDatasetMeta(0).data[r].x;t.save();t.fillStyle="rgba(100, 116, 139, 0.3)";t.fillRect(m,d,o-m,n-d);t.fillRect(g,d,a-g,n-d);t.lineWidth=1;t.strokeStyle="#22D3EE";t.strokeRect(o,d,g-o,n-d);t.restore()}};return{type:"line",data:{labels:s.map(d=>d.date),datasets:[{data:s.map(d=>d.price),borderColor:"#475569",fill:!1,pointRadius:0,borderWidth:1}]},options:{responsive:!0,maintainAspectRatio:!1,plugins:{legend:{display:!1},tooltip:{enabled:!1},brush:{startIndex:Math.max(0,s.length-252),endIndex:s.length-1}},scales:{y:{display:!1},x:{display:!1}}},plugins:[e]}}

    // --- START THE APP ---
    initialize();
});
