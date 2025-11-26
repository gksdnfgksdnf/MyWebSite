const http = require('http');
const url = require('url');
const qs = require('querystring');
const fs = require('fs');
const marked = require('marked');
const crypto = require('crypto');

// --- 상수 및 전역 데이터 ---
const TOPICS_FILE_PATH = 'topics.json';
const USERS_FILE_PATH = 'users.json';
const DEFAULT_ITEMS_PER_PAGE = 10;

// 초기 토픽 목록
const initialTopics = [
    { id: 1, title: '서비스 안내', description: '이 게시판은 로그인 기반 서비스입니다. 회원가입 후 이용해 주세요.', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), author: 0 },
];

let topics = [];
let users = [];
let nextId = 1;
let nextUserId = 1;
const sessions = {}; 


// --- 헬퍼 함수: 데이터 로드/저장 통합 ---

function loadData(filePath, initialData = []) {
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') {
            saveData(filePath, initialData);
        } else {
            console.error(`데이터 파일(${filePath}) 읽기 오류:`, err);
        }
        return initialData;
    }
}

function saveData(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 4), 'utf8');
    } catch (err) {
        console.error(`데이터 파일(${filePath}) 쓰기 오류:`, err);
    }
}

// 초기 데이터 로드 및 ID 설정
topics = loadData(TOPICS_FILE_PATH, initialTopics);
nextId = topics.length > 0 ? Math.max(...topics.map(t => t.id)) + 1 : 1;
users = loadData(USERS_FILE_PATH, []);
nextUserId = users.length > 0 ? Math.max(...users.map(u => u.id)) + 1 : 1;
marked.setOptions({ breaks: true }); //줄바꿈

// 데이터 저장 함수 별칭 설정
const saveTopics = () => saveData(TOPICS_FILE_PATH, topics);
const saveUsers = () => saveData(USERS_FILE_PATH, users);

// --- 기타 헬퍼 함수 ---

const generateSessionId = () => crypto.randomBytes(16).toString('hex');
const isEmptyOrWhitespace = (str) => (!str || str.trim().length === 0);

function parseCookies(request) {
    const list = {};
    const cookieHeader = request.headers.cookie;
    if (!cookieHeader) return list;
    cookieHeader.split(';').forEach(function(cookie) {
        let parts = cookie.split('=');
        list[parts[0].trim()] = parts[1] ? decodeURIComponent(parts[1].trim()) : '';
    });
    return list;
}

function getLoggedInUser(request) {
    const cookies = parseCookies(request);
    const sessionId = cookies.sessionId;
    if (sessionId && sessions[sessionId]) {
        const userId = sessions[sessionId];
        const user = users.find(u => u.id === userId);
        if (user) {
            const loggedInUser = { ...user };
            delete loggedInUser.password;
            return loggedInUser;
        }
    }
    return null;
}

// 게시글 정렬 로직
function sortTopics(topicArray, sort) {
    const sorted = [...topicArray];
    switch (sort) {
        case 'latest':
            return sorted.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        case 'oldest':
            return sorted.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        case 'title_asc':
            return sorted.sort((a, b) => a.title.localeCompare(b.title));
        default:
            return sorted.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
}

// --- UI 템플릿 함수 ---

// 목록 UI 생성 함수 (보기 옵션, 정렬 옵션 포함)
function templateList(topics, page, limit, sort) {
    const baseQuery = `page=${page}&limit=${limit}&sort=${sort}`;
    
    // 정렬 옵션 링크들을 배열로 생성합니다.
    const sortOptions = { latest: '최신순', oldest: '오래된순', title_asc: '제목순 (A-Z)' };
    const sortLinks = Object.entries(sortOptions).map(([key, value]) => {
        const isActive = (key === sort) ? 'bg-indigo-100 text-indigo-700 font-bold' : 'text-gray-600 hover:text-indigo-600 hover:bg-indigo-50';
        return `<a href="/?page=1&limit=${limit}&sort=${key}" class="py-1 px-2 rounded-lg ${isActive} block text-center transition-colors duration-150">${value}</a>`;
    });

    // 보기 옵션 링크들을 배열로 생성합니다.
    const limitLinks = [10, 30, 50].map(l => {
        const isActive = (l === limit) ? 'bg-indigo-100 text-indigo-700 font-bold' : 'text-gray-600 hover:text-indigo-600 hover:bg-indigo-50';
        return `<a href="/?page=1&limit=${l}&sort=${sort}" class="py-1 px-2 rounded-lg ${isActive} block text-center transition-colors duration-150">${l}개씩 보기</a>`;
    });

    // **[수정된 2열 그리드 구조]**
    let optionRows = '';
    // 옵션 개수가 3개로 동일하므로 반복문을 돌며 행을 구성합니다.
    for (let i = 0; i < 3; i++) {
        optionRows += `
            <div class="grid grid-cols-2 gap-4">
                <!-- 1열: 정렬 옵션 -->
                <div>${sortLinks[i]}</div>
                <!-- 2열: 보기 옵션 -->
                <div>${limitLinks[i]}</div>
            </div>
        `;
    }

    const listControls = `
    <!-- 정렬/보기 컨트롤 (2열 그리드 스타일) -->
    <div class="mb-6 p-4 border border-indigo-200 rounded-xl bg-indigo-50 shadow-md max-w-sm mx-auto sm:max-w-none">
        <!-- 컬럼 헤더: 정렬, 보기 -->
        <div class="grid grid-cols-2 gap-4 mb-2 pb-2 border-b-2 border-indigo-300">
            <span class="text-indigo-800 font-extrabold text-center text-lg">정렬</span>
            <span class="text-indigo-800 font-extrabold text-center text-lg">보기</span>
        </div>
        
        <!-- 옵션 행들 -->
        <div class="space-y-1">
            ${optionRows}
        </div>
    </div>
    `;

    // 목록 항목
    const listItems = topics.map(topic => {
        // NOTE: 'users' 변수는 이 함수 외부의 전역 스코프에 정의되어 있어야 합니다.
        const authorUser = users.find(u => u.id === topic.author); 
        const authorName = authorUser ? authorUser.nickname : '시스템';
        return `
            <li class="list-item border-b border-gray-100 last:border-b-0 p-3 hover:bg-gray-50 rounded-md transition-colors duration-150">
                <a href="/?id=${topic.id}&${baseQuery}" class="text-lg font-semibold text-gray-800 hover:text-indigo-600 block transition-colors duration-150">
                    ${topic.title}
                </a>
                <span class="text-xs text-gray-400">
                    작성자: ${authorName} | 작성일: ${new Date(topic.created_at).toLocaleString('ko-KR')}
                </span>
            </li>
        `;
    }).join('');

    const listHtml = `
    ${listControls}
    <div class="content-box">
        <ul class="space-y-3">
            ${listItems}
        </ul>
        ${topics.length === 0 ? '<p class="text-center text-gray-500 py-4">게시글이 없습니다.</p>' : ''}
    </div>
    `;

    return listHtml;
}
// 페이지네이션 링크 생성 함수
function templatePagination(totalTopics, page, limit, sort) {
    const totalPages = Math.ceil(totalTopics / limit);
    if (totalPages <= 1) return '';

    let paginationHtml = '';
    const pageGroupSize = 5;
    const currentGroup = Math.ceil(page / pageGroupSize);
    const startPage = (currentGroup - 1) * pageGroupSize + 1;
    const endPage = Math.min(startPage + pageGroupSize - 1, totalPages);

    const baseLink = (p) => `/?page=${p}&limit=${limit}&sort=${sort}`;
    
    if (currentGroup > 1) {
        paginationHtml += `<a href="${baseLink(startPage - 1)}" class="p-2">&laquo;</a>`;
    }

    for (let i = startPage; i <= endPage; i++) {
        const currentClass = (i === page) ? 'current' : '';
        paginationHtml += `<a href="${baseLink(i)}" class="p-2 rounded-md ${currentClass}">${i}</a>`;
    }

    if (currentGroup * pageGroupSize < totalPages) {
        paginationHtml += `<a href="${baseLink(endPage + 1)}" class="p-2">&raquo;</a>`;
    }

    return `
        <div class="pagination flex justify-center items-center space-x-1 mt-4 mb-4 text-sm font-medium">
            ${paginationHtml}
        </div>
    `;
}

function templateHTML(title, list, body, control, sort, limit, page, loggedInUser) {
    const authStatus = loggedInUser ?
        `${loggedInUser.nickname}(${loggedInUser.username})님, 환영합니다! <form action="/logout_process" method="post" style="display:inline;"><button type="submit" class="text-red-500 hover:text-red-700 ml-2 font-bold focus:outline-none">로그아웃</button></form>` :
        '<a href="/login" class="text-green-500 hover:text-green-700 font-bold">로그인</a> | <a href="/register" class="text-indigo-500 hover:text-indigo-700 font-bold">회원가입</a>';

    const createLink = `/create?page=${page}&limit=${limit}&sort=${sort}`;

    return `
    <!doctype html>
    <html>
    <head>
        <title>게시판 - ${title}</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@100..900&display=swap');
            body { font-family: 'Noto Sans KR', sans-serif; background-color: #f1f5f9; }
            
            .list-container {
                flex-basis: 300px;
                flex-shrink: 0;
                min-width: 250px;
                max-width: 400px;
                @media (max-width: 768px) {
                    flex-basis: 100%;
                    max-width: 100%;
                    margin-bottom: 1rem;
                }
            }

            .content-box {
                max-height: 500px;
                overflow-y: auto;
                padding: 1rem;
                border: 1px solid #e2e8f0;
                border-radius: 0.5rem;
                background-color: #ffffff;
                box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05);
            }
            .list-item { transition: background-color 0.2s; }
            .list-item:hover { background-color: #f1f5f9; }
            
            .pagination a {
                color: #2563eb;
                transition: color 0.15s;
            }
            .pagination a.current {
                color: #8b5cf6 !important;
                font-weight: 700;
                text-decoration: underline;
            }
            .pagination a:hover {
                color: #1d4ed8;
            }

            .prose {
                /* 단어가 넘칠 때 자동으로 줄바꿈 (길이가 긴 URL 등에 유용) */
                word-break: break-word;
                /* 모든 단어를 띄어쓰기 없이 연결하여도 넘칠 때 강제 줄바꿈 */
                overflow-wrap: break-word; 
                /* 오버플로우 스크롤 숨김(필요 시) */
                /* overflow-x: auto; */ 
            }
        </style>
    </head>
    <body class="p-4 md:p-8">
        <div class="max-w-6xl mx-auto w-full">
            <header class="pb-4 border-b border-gray-300 mb-6 bg-white p-4 rounded-lg shadow-md">
                <h1 class="text-3xl md:text-4xl font-extrabold text-gray-900 mb-2">
                    <a href="/" class="text-indigo-600 hover:text-indigo-800 transition duration-150">Simple Board</a>
                </h1>
                <p class="text-sm text-gray-500">${authStatus}</p>
            </header>

            <main class="flex flex-col md:flex-row gap-6">
                <div class="list-container bg-white p-4 rounded-lg shadow-lg">
                    <div class="flex justify-between items-center mb-4">
                        <h2 class="text-xl font-bold text-gray-700">게시글 목록</h2>
                        <a href="${createLink}" class="bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold py-1.5 px-3 rounded-lg shadow-md transition duration-150">
                            + 새 글
                        </a>
                    </div>
                    ${list}
                </div>
                
                <div class="flex-1 bg-white p-6 rounded-lg shadow-lg min-h-[400px]">
                    <section>
                        ${body}
                        <div class="mt-6 pt-4 border-t border-gray-200 flex justify-end space-x-4">
                            ${control}
                        </div>
                    </section>
                </div>
            </main>
        </div>
    </body>
    </html>
    `;
}


// --- 서버 생성 및 요청 처리 ---

const app = http.createServer((request, response) => {
    const _url = request.url;
    const parsedUrl = url.parse(_url, true);
    const pathName = parsedUrl.pathname;
    const query = parsedUrl.query;
    const loggedInUser = getLoggedInUser(request);
    
    // 빈 목록 HTML 생성 (템플릿용)
    const emptyListHtml = templateList([], 1, DEFAULT_ITEMS_PER_PAGE, 'latest'); 

    if (pathName === '/') {
        // 페이지네이션 및 정렬 파라미터 처리 (상태 유지)
        const topicId = query.id;
        const page = parseInt(query.page) || 1; 
        const limit = parseInt(query.limit) || DEFAULT_ITEMS_PER_PAGE; 
        const sort = query.sort || 'latest'; 

        // 1. 정렬
        const sortedTopics = sortTopics(topics, sort);

        // 2. 페이지네이션 범위 계산
        const totalTopics = sortedTopics.length;
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const pagedTopics = sortedTopics.slice(startIndex, endIndex);

        let title = '환영합니다';
        let description = 'Node.js 기반의 간단한 게시판 서비스입니다.';
        let listHtml = '';
        let bodyHtml = '';
        let controlHtml = '';

        // 3. 페이지네이션 및 목록 생성
        const paginationHtml = templatePagination(totalTopics, page, limit, sort);
        const list = templateList(pagedTopics, page, limit, sort);
        
        listHtml = paginationHtml + list;
        
        if (topicId) {
            // 상세 보기
            const topic = topics.find(t => t.id === parseInt(topicId));
            if (topic) {
                const authorUser = users.find(u => u.id === topic.author);
                const authorName = authorUser ? authorUser.nickname : '시스템';

                title = topic.title;
                const markdownContent = marked.parse(topic.description);
                bodyHtml = `
                    <h2 class="text-2xl font-bold mb-4 text-gray-800">${title}</h2>
                    <p class="text-sm text-gray-500 mb-4">작성자: ${authorName} | 작성일: ${new Date(topic.created_at).toLocaleString('ko-KR')}</p>
                    <div class="prose text-gray-700">${markdownContent}</div>
                `;
                
                // 수정/삭제 버튼 제어
                const baseQuery = `page=${page}&limit=${limit}&sort=${sort}`;
                if (loggedInUser && loggedInUser.id === topic.author) {
                    controlHtml = `
                        <a href="/update?id=${topicId}&${baseQuery}" class="text-orange-500 hover:text-orange-700 font-bold">수정</a>
                        <form action="/delete_process" method="post" onsubmit="return confirm('정말로 삭제하시겠습니까?');" style="display:inline;">
                            <input type="hidden" name="id" value="${topicId}">
                            <input type="hidden" name="page" value="${page}">
                            <input type="hidden" name="limit" value="${limit}">
                            <input type="hidden" name="sort" value="${sort}">
                            <button type="submit" class="text-red-500 hover:text-red-700 font-bold ml-4">삭제</button>
                        </form>
                    `;
                }
            } else {
                title = '404 Not Found';
                bodyHtml = '<h2 class="text-xl font-semibold mb-2">게시글을 찾을 수 없습니다.</h2>';
            }
        } else {
             // 메인 페이지 소개
             bodyHtml = `
                <h2 class="text-xl font-semibold mb-2 text-gray-800">서비스 소개</h2>
                <p class="text-gray-600">${description}</p>
             `;
        }

        const html = templateHTML(title, listHtml, bodyHtml, controlHtml, sort, limit, page, loggedInUser);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(html);

    } else if (pathName === '/create') {
        if (!loggedInUser) {
            response.writeHead(302, { 'Location': '/login' });
            response.end();
            return;
        }
        
        // 쿼리 파라미터를 그대로 폼에 숨겨서 POST에 전달
        const page = query.page || 1; 
        const limit = query.limit || DEFAULT_ITEMS_PER_PAGE; 
        const sort = query.sort || 'latest'; 
        
        const bodyHtml = `
            <form action="/create_process" method="post" class="space-y-4">
                <input type="hidden" name="page" value="${page}">
                <input type="hidden" name="limit" value="${limit}">
                <input type="hidden" name="sort" value="${sort}">

                <div>
                    <label for="title" class="block text-sm font-medium text-gray-700">제목</label>
                    <input type="text" id="title" name="title" required class="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2 focus:ring-indigo-500 focus:border-indigo-500">
                </div>
                <div>
                    <label for="description" class="block text-sm font-medium text-gray-700">내용 (Markdown 지원)</label>
                    <textarea id="description" name="description" rows="10" required class="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2 focus:ring-indigo-500 focus:border-indigo-500"></textarea>
                </div>
                <button type="submit" class="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded-lg transition duration-150">작성 완료</button>
            </form>
        `;

        const html = templateHTML('글 작성', emptyListHtml, bodyHtml, '', sort, limit, page, loggedInUser);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(html);

    } else if (pathName === '/update') {
        if (!loggedInUser) {
            response.writeHead(302, { 'Location': '/login' });
            response.end();
            return;
        }

        const topicId = parseInt(query.id);
        const topic = topics.find(t => t.id === topicId);
        
        if (!topic || topic.author !== loggedInUser.id) {
            response.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(templateHTML('403', emptyListHtml, '<h1>403 Forbidden</h1><p>수정 권한이 없습니다.</p>', '', query.sort, query.limit, query.page, loggedInUser));
            return;
        }
        
        // 쿼리 파라미터를 그대로 폼에 숨겨서 POST에 전달
        const page = query.page || 1; 
        const limit = query.limit || DEFAULT_ITEMS_PER_PAGE; 
        const sort = query.sort || 'latest'; 

        const bodyHtml = `
            <form action="/update_process" method="post" class="space-y-4">
                <input type="hidden" name="id" value="${topic.id}">
                <input type="hidden" name="page" value="${page}">
                <input type="hidden" name="limit" value="${limit}">
                <input type="hidden" name="sort" value="${sort}">

                <div>
                    <label for="title" class="block text-sm font-medium text-gray-700">제목</label>
                    <input type="text" id="title" name="title" value="${topic.title}" required class="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2 focus:ring-indigo-500 focus:border-indigo-500">
                </div>
                <div>
                    <label for="description" class="block text-sm font-medium text-gray-700">내용 (Markdown 지원)</label>
                    <textarea id="description" name="description" rows="10" required class="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2 focus:ring-indigo-500 focus:border-indigo-500">${topic.description}</textarea>
                </div>
                <button type="submit" class="bg-orange-600 hover:bg-orange-700 text-white font-bold py-2 px-4 rounded-lg transition duration-150">수정 완료</button>
            </form>
        `;

        const html = templateHTML('글 수정', emptyListHtml, bodyHtml, '', sort, limit, page, loggedInUser);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(html);

    } else if (pathName === '/login') {
        if (loggedInUser) {
            response.writeHead(302, { 'Location': '/' });
            response.end();
            return;
        }

        const loginHtml = `
            <form action="/login_process" method="post" class="space-y-4 max-w-md mx-auto p-6 bg-white rounded-lg shadow-lg">
                <h2 class="text-2xl font-bold mb-4 text-gray-800">로그인</h2>
                <div>
                    <label for="username" class="block text-sm font-medium text-gray-700">아이디</label>
                    <input type="text" id="username" name="username" required class="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2 focus:ring-green-500 focus:border-green-500">
                </div>
                <div>
                    <label for="password" class="block text-sm font-medium text-gray-700">비밀번호</label>
                    <input type="password" id="password" name="password" required class="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2 focus:ring-green-500 focus:border-green-500">
                </div>
                <button type="submit" class="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded-lg transition duration-150">로그인</button>
            </form>
            <p class="text-center mt-4 text-gray-600">계정이 없으신가요? <a href="/register" class="text-indigo-500 hover:text-indigo-700 font-bold">회원가입</a></p>
        `;
        const html = templateHTML('로그인', emptyListHtml, loginHtml, '', query.sort, query.limit, query.page, loggedInUser);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(html);

    } else if (pathName === '/register') {
        const registerHtml = `
            <form action="/register_process" method="post" class="space-y-4 max-w-md mx-auto p-6 bg-white rounded-lg shadow-lg">
                <h2 class="text-2xl font-bold mb-4 text-gray-800">회원가입</h2>
                <div>
                    <label for="nickname" class="block text-sm font-medium text-gray-700">닉네임</label>
                    <input type="text" id="nickname" name="nickname" required class="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2 focus:ring-indigo-500 focus:border-indigo-500">
                </div>
                <div>
                    <label for="username" class="block text-sm font-medium text-gray-700">아이디 (영문/숫자, 4자 이상)</label>
                    <input type="text" id="username" name="username" required pattern="[a-zA-Z0-9]{4,}" title="영문 또는 숫자로 4자 이상 입력해야 합니다." class="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2 focus:ring-indigo-500 focus:border-indigo-500">
                </div>
                <div>
                    <label for="password" class="block text-sm font-medium text-gray-700">비밀번호</label>
                    <input type="password" id="password" name="password" required class="mt-1 block w-full border border-gray-300 rounded-md shadow-sm p-2 focus:ring-indigo-500 focus:border-indigo-500">
                </div>
                <button type="submit" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-4 rounded-lg transition duration-150">회원가입</button>
            </form>
            <p class="text-center mt-4 text-gray-600">이미 계정이 있으신가요? <a href="/login" class="text-green-500 hover:text-green-700 font-bold">로그인</a></p>
        `;
        const html = templateHTML('회원가입', emptyListHtml, registerHtml, '', query.sort, query.limit, query.page, loggedInUser);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(html);

    } else if (pathName === '/logout_process') {
        const cookies = parseCookies(request);
        const sessionId = cookies.sessionId;
        if (sessionId) {
            delete sessions[sessionId];
        }
        
        response.writeHead(302, { 
            'Location': '/',
            'Set-Cookie': `sessionId=; Path=/; Max-Age=0` // 쿠키 만료
        });
        response.end();

    } else if (request.method === 'POST') {
        let body = '';
        request.on('data', function(data) {
            body += data;
        });

        request.on('end', async function() {
            let post = {};
            try {
                post = qs.parse(body);
                const pathName = parsedUrl.pathname;
                const postLoggedInUser = getLoggedInUser(request);

                // POST 요청에서 페이지네이션 상태를 가져와 리다이렉트 시 사용
                const page = post.page || 1;
                const limit = post.limit || DEFAULT_ITEMS_PER_PAGE;
                const sort = post.sort || 'latest';
                // 리다이렉트를 위한 쿼리 스트링 (id 제외)
                const listBaseQuery = `page=${page}&limit=${limit}&sort=${sort}`;
                
                if (pathName === '/create_process') {
                    if (!postLoggedInUser) throw new Error('Not logged in');
                    if (isEmptyOrWhitespace(post.title) || isEmptyOrWhitespace(post.description)) {
                        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                        response.end(templateHTML('오류', emptyListHtml, '<h1>400 Bad Request</h1><p>제목과 내용을 모두 입력해 주세요.</p>', '', sort, limit, page, postLoggedInUser));
                        return;
                    }
                    
                    const newTopic = {
                        id: nextId++,
                        title: post.title,
                        description: post.description,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                        author: postLoggedInUser.id 
                    };
                    topics.push(newTopic);
                    saveTopics();
                    
                    // 새 글 작성 후 1페이지로 돌아가되, limit/sort는 유지
                    response.writeHead(302, { 'Location': `/?${listBaseQuery}` });
                    response.end();

                } else if (pathName === '/update_process') {
                    if (!postLoggedInUser) throw new Error('Not logged in');
                    const idToUpdate = parseInt(post.id);
                    const topicIndex = topics.findIndex(t => t.id === idToUpdate);
                    
                    if (topicIndex === -1 || topics[topicIndex].author !== postLoggedInUser.id) {
                        response.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
                        response.end(templateHTML('403', emptyListHtml, '<h1>403 Forbidden</h1><p>수정 권한이 없습니다.</p>', '', sort, limit, page, postLoggedInUser));
                        return;
                    }
                    
                    topics[topicIndex].title = post.title;
                    topics[topicIndex].description = post.description;
                    topics[topicIndex].updated_at = new Date().toISOString();
                    saveTopics();
                    
                    // 수정 후 해당 토픽 페이지로 돌아가되, 페이지네이션 상태 고정
                    response.writeHead(302, { 'Location': `/?id=${idToUpdate}&${listBaseQuery}` });
                    response.end();
                    
                } else if (pathName === '/delete_process') {
                    if (!postLoggedInUser) throw new Error('Not logged in');
                    const idToDelete = parseInt(post.id);
                    const topicToDelete = topics.find(t => t.id === idToDelete);

                    if (!topicToDelete || topicToDelete.author !== postLoggedInUser.id) {
                        response.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
                        response.end(templateHTML('403', emptyListHtml, '<h1>403 Forbidden</h1><p>삭제 권한이 없습니다.</p>', '', sort, limit, page, postLoggedInUser));
                        return;
                    }

                    topics = topics.filter(t => t.id !== idToDelete);
                    saveTopics();

                    // 삭제 후 목록 페이지로 돌아가되, limit/sort는 유지
                    response.writeHead(302, { 'Location': `/?${listBaseQuery}` });
                    response.end();
                    
                } else if (pathName === '/register_process') {
                    if (isEmptyOrWhitespace(post.username) || isEmptyOrWhitespace(post.password) || isEmptyOrWhitespace(post.nickname)) {
                        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                        response.end(templateHTML('오류', emptyListHtml, '<h1>400 Bad Request</h1><p>모든 필드를 입력해 주세요.</p>', '', sort, limit, page, postLoggedInUser));
                        return;
                    }

                    if (users.some(u => u.username === post.username)) {
                        response.writeHead(409, { 'Content-Type': 'text/html; charset=utf-8' });
                        response.end(templateHTML('오류', emptyListHtml, '<h1>409 Conflict</h1><p>이미 존재하는 아이디입니다.</p><p><a href="/register">다시 시도</a></p>', '', sort, limit, page, postLoggedInUser));
                        return;
                    }

                    const newUser = {
                        id: nextUserId++,
                        username: post.username,
                        password: post.password, 
                        nickname: post.nickname
                    };
                    users.push(newUser);
                    saveUsers();

                    // 회원가입 성공 후 로그인 페이지로 리다이렉트
                    response.writeHead(302, { 'Location': '/login' });
                    response.end();

                } else if (pathName === '/login_process') {
                    const user = users.find(u => u.username === post.username && u.password === post.password);

                    if (user) {
                        const sessionId = generateSessionId();
                        sessions[sessionId] = user.id;

                        response.writeHead(302, { 
                            'Location': '/',
                            'Set-Cookie': `sessionId=${sessionId}; Path=/; HttpOnly; Max-Age=${60 * 60 * 24 * 30}` // 30일 세션
                        });
                        response.end();
                    } else {
                        response.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
                        response.end(templateHTML('로그인 실패', emptyListHtml, '<h1>401 Unauthorized</h1><p>아이디 또는 비밀번호가 올바르지 않습니다.</p><p><a href="/login">다시 시도</a></p>', '', sort, limit, page, postLoggedInUser));
                    }
                }

            } catch (error) {
                 console.error('POST 처리 중 오류 발생:', error);
                 response.writeHead(500, {'Content-Type': 'text/html; charset=utf-8'}); 
                 
                 const errorBody = `
                    <div class="error-container">
                        <h2>💥 500 Internal Server Error</h2>
                        <p>데이터 처리 중 치명적인 서버 오류가 발생했습니다.</p>
                        <p>잠시 후 다시 시도해 주십시오.</p>
                        <p><a href="/">홈으로 돌아가기</a></p>
                    </div>
                 `;
                 
                 const errorHtml = templateHTML('500 Error', emptyListHtml, errorBody, '', 'latest', DEFAULT_ITEMS_PER_PAGE, 1, null);
                 response.end(errorHtml);
            }
        });
    } else {
        // 404 Not Found
        response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        const errorBody = `
            <h1>404 Not Found</h1>
            <p>요청하신 페이지를 찾을 수 없습니다.</p>
            <p><a href="/">홈으로 돌아가기</a></p>
        `;
        const html = templateHTML('404 Not Found', emptyListHtml, errorBody, '', query.sort, query.limit, query.page, loggedInUser);
        response.end(html);
    }
});

app.listen(3000, () => {
    console.log('✅ Server running at http://localhost:3000/');
});