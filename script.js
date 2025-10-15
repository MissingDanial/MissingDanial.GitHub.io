// 宠物星座网站交互逻辑
// 阿里云Qwen API 配置
const QWEN_API_KEY = 'sk-92f6a444480a4b9eba3dd923fd3424dc';
const QWEN_API_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

// 速率限制器类 - 基于固定时间窗口
class RateLimiter {
    constructor(maxRequests = 10, windowMs = 60000) { // 默认1分钟内最多10次请求
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
        this.clients = new Map(); // 存储客户端请求记录
        this.rejectedLogs = []; // 存储被拒绝的请求日志
        
        // 定期清理过期的客户端记录
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, this.windowMs);
    }

    // 获取客户端标识符（基于IP、User-Agent等）
    getClientId() {
        // 在浏览器环境中，我们使用多个因素来标识客户端
        const fingerprint = [
            navigator.userAgent,
            navigator.language,
            screen.width + 'x' + screen.height,
            new Date().getTimezoneOffset(),
            navigator.platform
        ].join('|');
        
        // 生成简单的哈希值作为客户端ID
        let hash = 0;
        for (let i = 0; i < fingerprint.length; i++) {
            const char = fingerprint.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // 转换为32位整数
        }
        return Math.abs(hash).toString(36);
    }

    // 检查是否允许请求
    isAllowed() {
        const clientId = this.getClientId();
        const now = Date.now();
        const windowStart = now - this.windowMs;

        // 获取或创建客户端记录
        if (!this.clients.has(clientId)) {
            this.clients.set(clientId, {
                requests: [],
                windowStart: now
            });
        }

        const clientData = this.clients.get(clientId);
        
        // 清理过期的请求记录
        clientData.requests = clientData.requests.filter(timestamp => timestamp > windowStart);
        
        // 检查是否超过限制
        if (clientData.requests.length >= this.maxRequests) {
            // 记录被拒绝的请求
            this.logRejectedRequest(clientId, now);
            return false;
        }

        // 记录新请求
        clientData.requests.push(now);
        return true;
    }

    // 记录被拒绝的请求
    logRejectedRequest(clientId, timestamp) {
        const logEntry = {
            clientId,
            timestamp,
            date: new Date(timestamp).toISOString(),
            reason: 'Rate limit exceeded',
            maxRequests: this.maxRequests,
            windowMs: this.windowMs
        };
        
        this.rejectedLogs.push(logEntry);
        
        // 限制日志数量，避免内存泄漏
        if (this.rejectedLogs.length > 1000) {
            this.rejectedLogs = this.rejectedLogs.slice(-500);
        }
        
        // 输出到控制台用于调试
        console.warn('请求被拒绝 - 速率限制:', logEntry);
    }

    // 清理过期的客户端记录
    cleanup() {
        const now = Date.now();
        const cutoff = now - this.windowMs * 2; // 保留2个窗口期的数据
        
        for (const [clientId, clientData] of this.clients.entries()) {
            // 清理过期请求
            clientData.requests = clientData.requests.filter(timestamp => timestamp > cutoff);
            
            // 如果客户端长时间无请求，删除记录
            if (clientData.requests.length === 0 && clientData.windowStart < cutoff) {
                this.clients.delete(clientId);
            }
        }
    }

    // 获取当前客户端的请求统计
    getClientStats() {
        const clientId = this.getClientId();
        const clientData = this.clients.get(clientId);
        
        if (!clientData) {
            return {
                requestCount: 0,
                remainingRequests: this.maxRequests,
                resetTime: Date.now() + this.windowMs
            };
        }

        const now = Date.now();
        const windowStart = now - this.windowMs;
        const validRequests = clientData.requests.filter(timestamp => timestamp > windowStart);
        
        return {
            requestCount: validRequests.length,
            remainingRequests: Math.max(0, this.maxRequests - validRequests.length),
            resetTime: Math.min(...validRequests) + this.windowMs
        };
    }

    // 获取被拒绝请求的日志
    getRejectedLogs(limit = 50) {
        return this.rejectedLogs.slice(-limit);
    }

    // 销毁速率限制器
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        this.clients.clear();
        this.rejectedLogs = [];
    }
}

// 创建全局速率限制器实例
const rateLimiter = new RateLimiter(5, 60000); // 1分钟内最多5次请求

// API 调用函数
async function callQwenAI(prompt) {
    try {
        // 速率限制检查
        if (!rateLimiter.isAllowed()) {
            const stats = rateLimiter.getClientStats();
            const resetTime = new Date(stats.resetTime);
            const waitMinutes = Math.ceil((stats.resetTime - Date.now()) / 60000);
            
            const error = new Error(`请求过于频繁，请稍后重试。剩余请求次数: ${stats.remainingRequests}，重置时间: ${resetTime.toLocaleTimeString()}（约${waitMinutes}分钟后）`);
            error.name = 'RateLimitError';
            error.status = 429;
            error.resetTime = stats.resetTime;
            error.remainingRequests = stats.remainingRequests;
            throw error;
        }

        // 检查网络连接
        if (!navigator.onLine) {
            throw new Error('网络连接不可用');
        }

        // 设置请求超时
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60秒超时

        const response = await fetch(QWEN_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${QWEN_API_KEY}`
            },
            body: JSON.stringify({
                model: "qwen-flash-2025-07-28",
                messages: [
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                extra_body: {
                    enable_thinking: true
                },
                stream: false
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            // 根据不同的HTTP状态码提供具体错误信息
            switch (response.status) {
                case 400:
                    throw new Error('API请求参数错误');
                case 401:
                    throw new Error('API密钥无效');
                case 403:
                    throw new Error('API访问被拒绝，请检查配额');
                case 429:
                    throw new Error('API请求频率过高，请稍后重试');
                case 500:
                    throw new Error('API服务器内部错误');
                default:
                    throw new Error(`API请求失败: ${response.status}`);
            }
        }

        const data = await response.json();
        
        // 验证API返回数据的完整性
        if (!data.choices || !data.choices[0] || !data.choices[0].message || !data.choices[0].message.content) {
            throw new Error('API返回数据格式异常');
        }

        return data.choices[0].message.content;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('API请求超时，请检查网络连接');
        }
        console.error('Qwen AI API调用失败:', error);
        throw error;
    }
}

class PetZodiacApp {
    constructor() {
        this.currentPage = 'home';
        this.userData = {
            ownerZodiac: '',
            petType: '',
            petTraits: []
        };
        // 轮播图状态管理 - 支持多个实例
        this.carousels = new Map(); // 使用Map来管理多个轮播图实例
        this.init();
    }

    init() {
        this.bindEvents();
        this.initCarousel();
        this.showPage('home');
    }

    bindEvents() {
        // 开始按钮
        const startButton = document.getElementById('startButton');
        if (startButton) {
            startButton.addEventListener('click', () => this.showPage('owner-page'));
        }

        // 主人信息页面下一步按钮
        const ownerNextButton = document.getElementById('ownerNextButton');
        if (ownerNextButton) {
            ownerNextButton.addEventListener('click', () => this.goToPetPage());
        }

        // 宠物信息页面生成结果按钮
        const petNextButton = document.getElementById('petNextButton');
        if (petNextButton) {
            petNextButton.addEventListener('click', (e) => this.handlePetSubmit(e));
        }

        // 返回按钮
        const backButtons = document.querySelectorAll('.back-button');
        backButtons.forEach(button => {
            button.addEventListener('click', () => this.goBack());
        });

        // 星座选择表单
        const zodiacForm = document.getElementById('zodiacForm');
        if (zodiacForm) {
            zodiacForm.addEventListener('submit', (e) => this.handleZodiacSubmit(e));
        }

        // 宠物信息表单
        const petForm = document.getElementById('petForm');
        if (petForm) {
            petForm.addEventListener('submit', (e) => this.handlePetSubmit(e));
        }

        // 重新开始按钮
        const restartButton = document.getElementById('restartButton');
        if (restartButton) {
            restartButton.addEventListener('click', () => this.restart());
        }

        // 分享按钮
        const shareButton = document.getElementById('shareButton');
        if (shareButton) {
            shareButton.addEventListener('click', () => this.shareResult());
        }

        // 特征标签点击事件
        const traitTags = document.querySelectorAll('.trait-tag');
        traitTags.forEach(tag => {
            tag.addEventListener('click', (e) => {
                // 如果点击的是checkbox本身，让浏览器默认行为处理
                if (e.target.type === 'checkbox') {
                    this.updateTraitSelection();
                    return;
                }
                
                // 如果点击的是label区域，阻止事件冒泡并手动切换checkbox
                e.preventDefault();
                const checkbox = tag.querySelector('input[type="checkbox"]');
                checkbox.checked = !checkbox.checked;
                this.updateTraitSelection();
            });
        });

        // 生日输入变化事件已移除，因为不再需要生日输入
        // const ownerBirthday = document.getElementById('owner-birthday');
        // if (ownerBirthday) {
        //     ownerBirthday.addEventListener('change', () => this.updateZodiac());
        // }
    }

    // 轮播图初始化
    initCarousel() {
        // 初始化所有轮播图实例
        this.initCarouselInstance('#carousel-slides');
        this.initCarouselInstance('#carousel-slides-form');
    }

    // 初始化单个轮播图实例
    initCarouselInstance(containerId) {
        const carouselContainer = document.querySelector(containerId);
        if (!carouselContainer) return;

        // 初始化该轮播图的状态
        this.carousels.set(containerId, {
            currentSlide: 0,
            totalSlides: 3,
            autoPlayInterval: null,
            isAutoPlaying: false
        });

        // 绑定指示器点击事件
        const carouselWrapper = carouselContainer.closest('.carousel-wrapper');
        const indicators = carouselWrapper.querySelectorAll('.indicator');
        indicators.forEach((indicator, index) => {
            indicator.addEventListener('click', () => {
                this.goToSlide(index, containerId);
            });
        });

        // 绑定触摸滑动事件
        this.bindCarouselSwipe(containerId);

        // 开始自动播放
        this.startAutoPlay(containerId);

        // 鼠标悬停时暂停自动播放
        carouselContainer.addEventListener('mouseenter', () => {
            this.pauseAutoPlay(containerId);
        });

        carouselContainer.addEventListener('mouseleave', () => {
            this.startAutoPlay(containerId);
        });
    }

    // 绑定轮播图滑动事件
    bindCarouselSwipe(containerId) {
        const carouselContainer = document.querySelector(containerId);
        if (!carouselContainer) return;

        let startX = 0;
        let startY = 0;
        let isDragging = false;

        carouselContainer.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            isDragging = true;
            this.pauseAutoPlay(containerId);
        });

        carouselContainer.addEventListener('touchmove', (e) => {
            if (!isDragging) return;
            e.preventDefault();
        });

        carouselContainer.addEventListener('touchend', (e) => {
            if (!isDragging) return;
            isDragging = false;

            const endX = e.changedTouches[0].clientX;
            const endY = e.changedTouches[0].clientY;
            const deltaX = endX - startX;
            const deltaY = endY - startY;

            // 确保是水平滑动
            if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
                if (deltaX > 0) {
                    this.prevSlide(containerId);
                } else {
                    this.nextSlide(containerId);
                }
            }

            this.startAutoPlay(containerId);
        });

        // 鼠标拖拽支持
        carouselContainer.addEventListener('mousedown', (e) => {
            startX = e.clientX;
            startY = e.clientY;
            isDragging = true;
            this.pauseAutoPlay(containerId);
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            e.preventDefault();
        });

        document.addEventListener('mouseup', (e) => {
            if (!isDragging) return;
            isDragging = false;

            const endX = e.clientX;
            const endY = e.clientY;
            const deltaX = endX - startX;
            const deltaY = endY - startY;

            if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
                if (deltaX > 0) {
                    this.prevSlide(containerId);
                } else {
                    this.nextSlide(containerId);
                }
            }

            this.startAutoPlay(containerId);
        });
    }

    // 切换到指定幻灯片
    goToSlide(index, containerId) {
        const carousel = this.carousels.get(containerId);
        if (!carousel || index < 0 || index >= carousel.totalSlides) return;

        // 更新当前幻灯片
        const carouselContainer = document.querySelector(containerId);
        const carouselWrapper = carouselContainer.closest('.carousel-wrapper');
        const slides = carouselWrapper.querySelectorAll('.carousel-slide');
        const indicators = carouselWrapper.querySelectorAll('.indicator');

        slides.forEach((slide, i) => {
            slide.classList.toggle('active', i === index);
        });

        indicators.forEach((indicator, i) => {
            indicator.classList.toggle('active', i === index);
        });

        carousel.currentSlide = index;
    }

    // 下一张幻灯片
    nextSlide(containerId) {
        const carousel = this.carousels.get(containerId);
        if (!carousel) return;
        
        const nextIndex = (carousel.currentSlide + 1) % carousel.totalSlides;
        this.goToSlide(nextIndex, containerId);
    }

    // 上一张幻灯片
    prevSlide(containerId) {
        const carousel = this.carousels.get(containerId);
        if (!carousel) return;
        
        const prevIndex = (carousel.currentSlide - 1 + carousel.totalSlides) % carousel.totalSlides;
        this.goToSlide(prevIndex, containerId);
    }

    // 开始自动播放
    startAutoPlay(containerId) {
        const carousel = this.carousels.get(containerId);
        if (!carousel) return;
        
        if (carousel.autoPlayInterval) {
            clearInterval(carousel.autoPlayInterval);
        }

        carousel.autoPlayInterval = setInterval(() => {
            this.nextSlide(containerId);
        }, 2000); // 每2秒切换一次
        
        carousel.isAutoPlaying = true;
    }

    // 暂停自动播放
    pauseAutoPlay(containerId) {
        const carousel = this.carousels.get(containerId);
        if (!carousel) return;
        
        if (carousel.autoPlayInterval) {
            clearInterval(carousel.autoPlayInterval);
            carousel.autoPlayInterval = null;
        }
        carousel.isAutoPlaying = false;
    }

    showPage(pageId) {
        // 隐藏所有页面
        const pages = document.querySelectorAll('.page');
        pages.forEach(page => page.classList.remove('active'));

        // 显示目标页面
        const targetPage = document.getElementById(pageId);
        if (targetPage) {
            targetPage.classList.add('active');
            this.currentPage = pageId;
        }

        // 更新导航栏
        this.updateNavigation();
    }

    updateNavigation() {
        const navbar = document.querySelector('.navbar');
        const backButton = document.querySelector('.back-button');
        const pageTitle = document.querySelector('.page-title');
        const progressIndicator = document.querySelector('.progress-indicator');

        if (this.currentPage === 'home') {
            if (backButton) backButton.style.display = 'none';
            if (pageTitle) pageTitle.textContent = '';
            if (progressIndicator) progressIndicator.textContent = '';
        } else {
            if (backButton) backButton.style.display = 'flex';
            
            switch (this.currentPage) {
                case 'zodiac':
                    if (pageTitle) pageTitle.textContent = '选择星座';
                    if (progressIndicator) progressIndicator.textContent = '1/2';
                    break;
                case 'pet':
                    if (pageTitle) pageTitle.textContent = '宠物信息';
                    if (progressIndicator) progressIndicator.textContent = '2/2';
                    break;
                case 'result':
                    if (pageTitle) pageTitle.textContent = '匹配结果';
                    if (progressIndicator) progressIndicator.textContent = '';
                    break;
            }
        }
    }

    goToPetPage() {
        // 验证主人信息
        const ownerZodiacEl = document.getElementById('owner-zodiac');

        if (!ownerZodiacEl) {
            console.error('找不到主人信息表单元素');
            return;
        }

        const ownerZodiac = ownerZodiacEl.value;

        // 验证必须选择了星座
        if (!ownerZodiac) {
            this.showErrorMessage('请选择你的星座');
            return;
        }

        // 保存主人信息
        this.userData.ownerName = '主人'; // 设置默认名称
        this.userData.ownerZodiac = ownerZodiac;

        if (this.userData.ownerZodiac) {
            this.showPage('pet-page');
        } else {
            alert('请选择你的星座');
        }
    }

    updateZodiac() {
        // 此函数已不再需要，因为移除了生日输入功能
        // 用户直接通过星座选择器选择星座
        console.log('updateZodiac函数已废弃，因为移除了生日输入功能');
    }

    calculateZodiacFromDate(dateString) {
        const date = new Date(dateString);
        const month = date.getMonth() + 1;
        const day = date.getDate();

        if ((month === 3 && day >= 21) || (month === 4 && day <= 19)) return 'aries';
        if ((month === 4 && day >= 20) || (month === 5 && day <= 20)) return 'taurus';
        if ((month === 5 && day >= 21) || (month === 6 && day <= 20)) return 'gemini';
        if ((month === 6 && day >= 21) || (month === 7 && day <= 22)) return 'cancer';
        if ((month === 7 && day >= 23) || (month === 8 && day <= 22)) return 'leo';
        if ((month === 8 && day >= 23) || (month === 9 && day <= 22)) return 'virgo';
        if ((month === 9 && day >= 23) || (month === 10 && day <= 22)) return 'libra';
        if ((month === 10 && day >= 23) || (month === 11 && day <= 21)) return 'scorpio';
        if ((month === 11 && day >= 22) || (month === 12 && day <= 21)) return 'sagittarius';
        if ((month === 12 && day >= 22) || (month === 1 && day <= 19)) return 'capricorn';
        if ((month === 1 && day >= 20) || (month === 2 && day <= 18)) return 'aquarius';
        if ((month === 2 && day >= 19) || (month === 3 && day <= 20)) return 'pisces';
        
        return 'aries'; // 默认值
    }

    goBack() {
        switch (this.currentPage) {
            case 'owner-page':
                this.showPage('home');
                break;
            case 'pet-page':
                this.showPage('owner-page');
                break;
            case 'result-page':
                this.showPage('pet-page');
                break;
        }
    }

    handleZodiacSubmit(e) {
        e.preventDefault();
        const formData = new FormData(e.target);
        this.userData.ownerZodiac = formData.get('zodiac');
        
        if (this.userData.ownerZodiac) {
            this.showPage('pet');
        }
    }

    handlePetSubmit(e) {
        e.preventDefault();
        
        // 获取宠物类型
        const petType = document.getElementById('pet-type').value;
        
        // 验证宠物类型是否已选择
        if (!petType || petType.trim() === '') {
            this.showErrorMessage('请选择宠物类型后再继续！');
            // 高亮显示宠物类型选择框
            const petTypeSelect = document.getElementById('pet-type');
            petTypeSelect.focus();
            petTypeSelect.style.borderColor = '#ff4757';
            petTypeSelect.style.boxShadow = '0 0 0 2px rgba(255, 71, 87, 0.2)';
            
            // 3秒后恢复原样式
            setTimeout(() => {
                petTypeSelect.style.borderColor = '';
                petTypeSelect.style.boxShadow = '';
            }, 3000);
            
            return;
        }
        
        this.userData.petType = petType;
        
        // 获取选中的特征
        const selectedTraits = [];
        const traitCheckboxes = document.querySelectorAll('input[name="traits"]:checked');
        traitCheckboxes.forEach(checkbox => {
            selectedTraits.push(checkbox.value);
        });
        this.userData.petTraits = selectedTraits;

        // 验证情绪与行为维度至少选择一个
        const emotionBehaviorTraits = ['obedient', 'intelligent', 'calm', 'curious'];
        const selectedEmotionBehaviorTraits = selectedTraits.filter(trait => 
            emotionBehaviorTraits.includes(trait)
        );

        if (selectedEmotionBehaviorTraits.length === 0) {
            this.showErrorMessage('请至少选择一个情绪与行为维度的特征！');
            return;
        }

        // 清除可能存在的错误样式
        const petTypeSelect = document.getElementById('pet-type');
        petTypeSelect.style.borderColor = '';
        petTypeSelect.style.boxShadow = '';

        this.generateResult();
    }

    updateTraitSelection() {
        const selectedTraits = document.querySelectorAll('input[name="traits"]:checked');
        // 可以在这里添加选择限制逻辑
    }

    generateResult() {
        // 获取宠物信息
        const petTypeEl = document.getElementById('pet-type');

        if (!petTypeEl) {
            console.error('找不到宠物信息表单元素');
            return;
        }

        const petType = petTypeEl.value;

        // 获取选中的特征
        const selectedTraits = [];
        const traitCheckboxes = document.querySelectorAll('input[name="traits"]:checked');
        traitCheckboxes.forEach(checkbox => {
            if (checkbox && checkbox.value) {
                selectedTraits.push(checkbox.value);
            }
        });

        // 保存宠物信息
        this.userData.petType = petType;
        this.userData.petTraits = selectedTraits;

        if (!petType) {
            alert('请选择宠物类型');
            return;
        }

        // 显示加载动画
        this.showLoading();

        // 使用AI API进行分析
        this.calculateCompatibilityWithAI()
            .then(result => {
                this.displayResult(result);
                this.hideLoading();
                this.showPage('result-page');
            })
            .catch(error => {
                console.error('AI分析失败:', error);
                
                // 检查是否为速率限制错误
                if (error.name === 'RateLimitError') {
                    this.hideLoading();
                    const resetTime = new Date(error.resetTime).toLocaleTimeString();
                    this.showErrorMessage(`请求过于频繁，请稍后再试。剩余请求次数：${error.remainingRequests}，重置时间：${resetTime}`);
                    return;
                }
                
                // 显示用户友好的错误提示
                this.showErrorMessage('AI分析服务暂时不可用，正在使用本地算法为您分析...');
                
                // 短暂延迟后使用本地算法
                setTimeout(() => {
                    try {
                        const result = this.calculateCompatibilityLocal();
                        this.displayResult(result);
                        this.hideLoading();
                        this.showPage('result-page');
                    } catch (localError) {
                        console.error('本地算法也失败了:', localError);
                        this.hideLoading();
                        this.showErrorMessage('分析过程出现问题，请稍后重试');
                    }
                }, 1000);
            });
    }

    // 使用AI API进行兼容性分析
    async calculateCompatibilityWithAI() {
        // 星座中文名映射
        const zodiacNames = {
            'aries': '白羊座',
            'taurus': '金牛座', 
            'gemini': '双子座',
            'cancer': '巨蟹座',
            'leo': '狮子座',
            'virgo': '处女座',
            'libra': '天秤座',
            'scorpio': '天蝎座',
            'sagittarius': '射手座',
            'capricorn': '摩羯座',
            'aquarius': '水瓶座',
            'pisces': '双鱼座'
        };

        const ownerZodiacChinese = zodiacNames[this.userData.ownerZodiac] || '白羊座';
        
        // 构建AI分析提示
        const prompt = `
请你以「资深宠物星座分析师」的身份，结合宠物星座的性格特质、行为逻辑、相处适配性等专业维度，对宠物进行深度分析。分析需包含以下信息，且内容要贴合宠物真实习性，避免笼统化，同时语言要温暖易懂，带少量趣味解读：

主人信息：
- 星座：${ownerZodiacChinese}

宠物信息：
- 类型：${this.userData.petType}
- 性格特征：${this.userData.petTraits.join('、')}

请提供以下分析结果，格式必须严格按照JSON格式返回：
{
  "petZodiac": "为宠物分配一个最适合的星座（中文名）",
  "compatibilityScore": 数字（0-100之间的整数），
  "compatibilityLevel": "匹配等级（完美匹配/高度匹配/良好匹配/一般匹配/需要磨合）",
  "analysis": "详细的性格匹配分析（100-200字）",
  "tips": "具体的相处建议（3-5条建议，用数组格式）",
  "story": "一个温馨有趣的小故事（200-300字），描述主人星座与宠物星座的日常互动情节，体现两个星座的特性和相处模式，内容要生动有趣且符合星座特征",
  "funTags": "为宠物星座生成2-3个生动有趣的专属标签（用数组格式），例如：天蝎座宠物可标记为'隐藏的零食守卫者'，水瓶座宠物可描述为'独自观察人类的奇怪行为爱好者'，标签要幽默风趣且符合星座特征"
}

请确保返回的是有效的JSON格式，不要包含其他文字说明。
        `;

        try {
            const aiResponse = await callQwenAI(prompt);
            
            // 尝试解析AI返回的JSON
            let result;
            try {
                // 清理可能的markdown格式
                const cleanResponse = aiResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                result = JSON.parse(cleanResponse);
            } catch (parseError) {
                console.error('AI返回格式解析失败:', parseError);
                throw new Error('AI返回格式无效');
            }

            // 验证返回结果的完整性
            if (!result.petZodiac || !result.compatibilityScore || !result.analysis) {
                throw new Error('AI返回结果不完整');
            }

            // 确保分数在合理范围内
            result.compatibilityScore = Math.max(0, Math.min(100, parseInt(result.compatibilityScore)));
            
            // 如果没有tips或格式不正确，提供默认建议
            if (!Array.isArray(result.tips)) {
                result.tips = this.generateTips(ownerZodiacChinese, result.petZodiac);
            }

            return result;
        } catch (error) {
            console.error('AI分析过程出错:', error);
            throw error;
        }
    }

    // 本地兼容性计算（作为降级方案）
    calculateCompatibilityLocal() {
        // 星座中文名映射
        const zodiacNames = {
            'aries': '白羊座',
            'taurus': '金牛座', 
            'gemini': '双子座',
            'cancer': '巨蟹座',
            'leo': '狮子座',
            'virgo': '处女座',
            'libra': '天秤座',
            'scorpio': '天蝎座',
            'sagittarius': '射手座',
            'capricorn': '摩羯座',
            'aquarius': '水瓶座',
            'pisces': '双鱼座'
        };

        const ownerZodiacChinese = zodiacNames[this.userData.ownerZodiac] || '白羊座';

        // 简化的星座匹配算法
        const zodiacCompatibility = {
            '白羊座': { score: 85, traits: ['活泼', '好动', '勇敢'] },
            '金牛座': { score: 78, traits: ['温顺', '稳重', '忠诚'] },
            '双子座': { score: 92, traits: ['聪明', '好奇', '活泼'] },
            '巨蟹座': { score: 88, traits: ['温顺', '粘人', '敏感'] },
            '狮子座': { score: 90, traits: ['勇敢', '自信', '好动'] },
            '处女座': { score: 82, traits: ['聪明', '独立', '挑食'] },
            '天秤座': { score: 86, traits: ['温顺', '友好', '优雅'] },
            '天蝎座': { score: 79, traits: ['独立', '神秘', '忠诚'] },
            '射手座': { score: 94, traits: ['好动', '自由', '友好'] },
            '摩羯座': { score: 81, traits: ['稳重', '忠诚', '独立'] },
            '水瓶座': { score: 87, traits: ['聪明', '独特', '友好'] },
            '双鱼座': { score: 89, traits: ['温顺', '敏感', '粘人'] }
        };

        const ownerData = zodiacCompatibility[ownerZodiacChinese] || { score: 75, traits: [] };
        
        // 根据宠物特征调整分数
        let adjustedScore = ownerData.score;
        const matchingTraits = this.userData.petTraits.filter(trait => 
            ownerData.traits.includes(trait)
        );
        
        adjustedScore += matchingTraits.length * 3;
        adjustedScore = Math.min(adjustedScore, 100);

        // 生成宠物星座
        const petZodiacs = ['白羊座', '金牛座', '双子座', '巨蟹座', '狮子座', '处女座', 
                           '天秤座', '天蝎座', '射手座', '摩羯座', '水瓶座', '双鱼座'];
        const petZodiac = petZodiacs[Math.floor(Math.random() * petZodiacs.length)];

        return {
            petZodiac,
            compatibilityScore: adjustedScore,
            compatibilityLevel: this.getCompatibilityLevel(adjustedScore),
            analysis: this.generateAnalysis(adjustedScore, matchingTraits),
            tips: this.generateTips(ownerZodiacChinese, petZodiac),
            story: this.generateStory(ownerZodiacChinese, petZodiac),
            funTags: this.generateFunTags(petZodiac)
        };
    }

    getCompatibilityLevel(score) {
        if (score >= 90) return '完美匹配';
        if (score >= 80) return '高度匹配';
        if (score >= 70) return '良好匹配';
        if (score >= 60) return '一般匹配';
        return '需要磨合';
    }

    generateAnalysis(score, matchingTraits) {
        const analyses = [
            `你和宠物的星座匹配度很高！你们在性格上有很多相似之处，这让你们能够更好地理解彼此。`,
            `宠物的性格特征与你的星座特质相得益彰，你们之间有着天然的默契。`,
            `作为${this.userData.ownerZodiac}的你，与宠物形成了很好的互补关系，你们能够相互学习和成长。`
        ];
        
        return analyses[Math.floor(Math.random() * analyses.length)];
    }

    generateTips(ownerZodiac, petZodiac) {
        const tipsList = [
            '多花时间陪伴你的宠物，建立更深的情感连接',
            '了解宠物的个性特点，给予相应的关爱方式',
            '保持耐心，每个宠物都有自己的节奏',
            '定期与宠物互动，增进彼此的了解',
            '尊重宠物的独特性格，不要强求改变'
        ];
        
        return tipsList.slice(0, 3);
    }

    generateStory(ownerZodiac, petZodiac) {
        // 星座特性映射
        const zodiacTraits = {
            '白羊座': { personality: '热情冲动', behavior: '活泼好动', interaction: '喜欢追逐游戏' },
            '金牛座': { personality: '温和稳重', behavior: '慢条斯理', interaction: '享受安静陪伴' },
            '双子座': { personality: '聪明好奇', behavior: '变化多端', interaction: '喜欢新鲜事物' },
            '巨蟹座': { personality: '温柔体贴', behavior: '情感丰富', interaction: '需要安全感' },
            '狮子座': { personality: '自信骄傲', behavior: '威风凛凛', interaction: '喜欢被关注' },
            '处女座': { personality: '细致挑剔', behavior: '整洁有序', interaction: '注重细节' },
            '天秤座': { personality: '优雅和谐', behavior: '追求平衡', interaction: '喜欢美好事物' },
            '天蝎座': { personality: '神秘深沉', behavior: '专注执着', interaction: '忠诚但独立' },
            '射手座': { personality: '自由奔放', behavior: '爱好探索', interaction: '需要空间自由' },
            '摩羯座': { personality: '踏实可靠', behavior: '有条不紊', interaction: '建立规律习惯' },
            '水瓶座': { personality: '独特创新', behavior: '不拘一格', interaction: '喜欢独特方式' },
            '双鱼座': { personality: '梦幻敏感', behavior: '温柔多情', interaction: '需要情感呵护' }
        };

        const ownerTrait = zodiacTraits[ownerZodiac] || zodiacTraits['白羊座'];
        const petTrait = zodiacTraits[petZodiac] || zodiacTraits['金牛座'];

        const stories = [
            `每当夕阳西下，${ownerZodiac}的你总是会轻抚着${petZodiac}的小宠物。你的${ownerTrait.personality}性格让你能够理解它${petTrait.behavior}的天性。有一天，当你工作疲惫回到家时，小家伙似乎感受到了你的情绪，${petTrait.interaction}，用它独特的方式安慰着你。那一刻，你们之间的默契让彼此都感到无比温暖，仿佛整个世界都变得柔软起来。这种跨越物种的理解，正是你们星座特质完美融合的体现。`,
            
            `清晨的阳光透过窗帘洒在地板上，${petZodiac}的小宠物正在享受着这份宁静。作为${ownerZodiac}的你，${ownerTrait.behavior}地为它准备着早餐。突然，它做出了一个让你忍俊不禁的动作——${petTrait.interaction}。你们开始了一场有趣的互动游戏，你的${ownerTrait.personality}特质与它的${petTrait.personality}天性产生了奇妙的化学反应。这个平凡却温馨的早晨，成为了你们共同记忆中最珍贵的片段。`,
            
            `雨夜里，${ownerZodiac}的你正在阅读，${petZodiac}的小宠物安静地蜷缩在你身边。窗外雨声淅沥，室内温暖如春。你偶尔抬头看看它，发现它也在静静地观察着你。你们没有言语交流，却能感受到彼此的存在。你的${ownerTrait.personality}让你懂得${petTrait.interaction}的重要性，而它的${petTrait.behavior}也让你学会了珍惜这份简单的陪伴。这样的夜晚，让你们的心灵更加贴近。`
        ];

        return stories[Math.floor(Math.random() * stories.length)];
    }

    generateFunTags(petZodiac) {
        // 12个星座的专属趣味标签
        const zodiacFunTags = {
            '白羊座': [
                '冲锋陷阵的小勇士',
                '永远精力充沛的小火球',
                '见到陌生人就想交朋友的社交达人'
            ],
            '金牛座': [
                '隐藏的零食守卫者',
                '慢条斯理的生活哲学家',
                '对舒适度有着极致追求的享乐主义者'
            ],
            '双子座': [
                '好奇心爆棚的小侦探',
                '一秒变脸的情绪大师',
                '永远在寻找新鲜事物的探险家'
            ],
            '巨蟹座': [
                '温柔体贴的小天使',
                '情感丰富的小戏精',
                '家庭守护神般的存在'
            ],
            '狮子座': [
                '天生的小明星',
                '自带光环的王者气质',
                '永远想成为焦点的表演艺术家'
            ],
            '处女座': [
                '完美主义的小管家',
                '挑剔但贴心的生活顾问',
                '细节控中的战斗机'
            ],
            '天秤座': [
                '颜值即正义的美学家',
                '和谐相处的外交官',
                '选择困难症的典型代表'
            ],
            '天蝎座': [
                '神秘莫测的小间谍',
                '情感深沉的哲学家',
                '拥有超强直觉的心理学家'
            ],
            '射手座': [
                '自由奔放的冒险家',
                '乐观向上的开心果',
                '永远在路上的旅行达人'
            ],
            '摩羯座': [
                '稳重可靠的小大人',
                '目标明确的实干家',
                '低调内敛的成功学大师'
            ],
            '水瓶座': [
                '独自观察人类的奇怪行为爱好者',
                '脑洞大开的创意天才',
                '特立独行的个性艺术家'
            ],
            '双鱼座': [
                '浪漫主义的小诗人',
                '感性细腻的梦想家',
                '拥有治愈系魔法的小天使'
            ]
        };

        const tags = zodiacFunTags[petZodiac] || zodiacFunTags['白羊座'];
        // 随机选择2-3个标签
        const selectedTags = [];
        const tagCount = Math.floor(Math.random() * 2) + 2; // 2-3个标签
        
        while (selectedTags.length < tagCount && selectedTags.length < tags.length) {
            const randomTag = tags[Math.floor(Math.random() * tags.length)];
            if (!selectedTags.includes(randomTag)) {
                selectedTags.push(randomTag);
            }
        }
        
        return selectedTags;
    }

    displayResult(result) {
        // 星座符号映射
        const zodiacIcons = {
            '白羊座': '♈',
            '金牛座': '♉',
            '双子座': '♊',
            '巨蟹座': '♋',
            '狮子座': '♌',
            '处女座': '♍',
            '天秤座': '♎',
            '天蝎座': '♏',
            '射手座': '♐',
            '摩羯座': '♑',
            '水瓶座': '♒',
            '双鱼座': '♓'
        };

        // 更新星座
        const zodiacElements = document.querySelectorAll('.pet-zodiac');
        zodiacElements.forEach(el => {
            if (el) el.textContent = result.petZodiac;
        });

        // 更新星座徽章
        const zodiacNameElement = document.querySelector('.zodiac-name');
        const zodiacIconElement = document.querySelector('.zodiac-icon');
        if (zodiacNameElement && result.petZodiac) {
            zodiacNameElement.textContent = result.petZodiac;
        }
        if (zodiacIconElement && result.petZodiac && zodiacIcons[result.petZodiac]) {
            zodiacIconElement.textContent = zodiacIcons[result.petZodiac];
        }

        // 更新星座图片
        const zodiacImage = document.getElementById('zodiac-image');
        if (zodiacImage && result.petZodiac) {
            zodiacImage.src = `image/12/${result.petZodiac}.png`;
            zodiacImage.alt = `${result.petZodiac}图片`;
        }

        // 更新匹配分数
        const scoreElement = document.querySelector('.score-number');
        if (scoreElement) {
            scoreElement.textContent = result.compatibilityScore;
        }

        // 更新匹配等级
        const levelElement = document.querySelector('.compatibility-level');
        if (levelElement) {
            levelElement.textContent = result.compatibilityLevel;
        }

        // 更新分析内容
        const analysisElement = document.querySelector('.analysis-content');
        if (analysisElement) {
            analysisElement.textContent = result.analysis;
        }

        // 更新故事内容
        const storyElement = document.querySelector('.story-content');
        if (storyElement && result.story) {
            storyElement.textContent = result.story;
        }

        // 更新建议列表
        const tipsList = document.querySelector('.tips-list');
        if (tipsList) {
            tipsList.innerHTML = result.tips.map(tip => `<li>${tip}</li>`).join('');
        }

        // 更新趣味标签
        const funTagsList = document.querySelector('#fun-tags-list');
        if (funTagsList && result.funTags) {
            funTagsList.innerHTML = result.funTags.map(tag => `<span class="fun-tag">${tag}</span>`).join('');
        }

        // 更新进度环
        this.updateProgressBar(result.compatibilityScore);
    }

    updateProgressBar(score) {
        const progressFill = document.getElementById('progress-fill');
        if (progressFill) {
            // 设置进度条宽度
            progressFill.style.width = `${score}%`;
            
            // 根据分数设置颜色
            let color;
            if (score >= 80) {
                color = '#34C759'; // 绿色 - 高匹配
            } else if (score >= 60) {
                color = '#FF9500'; // 橙色 - 中等匹配
            } else {
                color = '#FF3B30'; // 红色 - 低匹配
            }
            
            // 使用单色而不是渐变，根据分数显示对应颜色
            progressFill.style.background = color;
        }
    }

    showLoading() {
        const loadingOverlay = document.querySelector('.loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.classList.add('active');
        }
    }

    hideLoading() {
        const loadingOverlay = document.querySelector('.loading-overlay');
        if (loadingOverlay) {
            loadingOverlay.classList.remove('active');
        }
    }

    // 显示错误消息
    showErrorMessage(message) {
        // 创建或更新错误提示元素
        let errorElement = document.querySelector('.error-message');
        if (!errorElement) {
            errorElement = document.createElement('div');
            errorElement.className = 'error-message';
            errorElement.style.cssText = `
                position: fixed;
                top: 20px;
                left: 50%;
                transform: translateX(-50%);
                background: #ff6b6b;
                color: white;
                padding: 12px 24px;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                z-index: 1000;
                font-size: 14px;
                max-width: 90%;
                text-align: center;
                animation: slideDown 0.3s ease-out;
            `;
            document.body.appendChild(errorElement);
        }
        
        errorElement.textContent = message;
        errorElement.style.display = 'block';
        
        // 3秒后自动隐藏
        setTimeout(() => {
            if (errorElement) {
                errorElement.style.animation = 'slideUp 0.3s ease-out';
                setTimeout(() => {
                    if (errorElement && errorElement.parentNode) {
                        errorElement.parentNode.removeChild(errorElement);
                    }
                }, 300);
            }
        }, 3000);
    }

    restart() {
        this.userData = {
            ownerZodiac: '',
            petType: '',
            petTraits: []
        };
        
        // 重置表单
        const forms = document.querySelectorAll('form');
        forms.forEach(form => form.reset());
        
        // 重置特征选择
        const traitCheckboxes = document.querySelectorAll('input[name="traits"]');
        traitCheckboxes.forEach(checkbox => checkbox.checked = false);
        
        this.showPage('home');
    }

    shareResult() {
        const petZodiacElement = document.querySelector('.pet-zodiac');
        const scoreElement = document.querySelector('.score-number');
        
        const petZodiac = petZodiacElement ? petZodiacElement.textContent : '未知星座';
        const score = scoreElement ? scoreElement.textContent : '未知';
        
        const shareText = `我的宠物是${petZodiac}，我们的匹配度是${score}分！快来测试你和宠物的星座匹配度吧！`;
        
        if (navigator.share) {
            navigator.share({
                title: '宠物星座匹配结果',
                text: shareText,
                url: window.location.href
            });
        } else {
            // 复制到剪贴板
            navigator.clipboard.writeText(shareText).then(() => {
                alert('结果已复制到剪贴板！');
            });
        }
    }
}

// 页面加载完成后初始化应用
document.addEventListener('DOMContentLoaded', () => {
    new PetZodiacApp();
});

// 添加一些实用工具函数
const utils = {
    // 格式化日期
    formatDate(date) {
        return new Intl.DateTimeFormat('zh-CN').format(date);
    },
    
    // 防抖函数
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    },
    
    // 节流函数
    throttle(func, limit) {
        let inThrottle;
        return function() {
            const args = arguments;
            const context = this;
            if (!inThrottle) {
                func.apply(context, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }
};

// 添加页面可见性检测
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        // 页面隐藏时的处理
        console.log('页面已隐藏');
    } else {
        // 页面显示时的处理
        console.log('页面已显示');
    }
});

// 添加错误处理
window.addEventListener('error', (e) => {
    console.error('页面错误:', e.error);
});

// 添加未处理的Promise拒绝处理
window.addEventListener('unhandledrejection', (e) => {
    console.error('未处理的Promise拒绝:', e.reason);
    e.preventDefault();
});