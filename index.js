const express = require('express');
const { OpenAI } = require('openai');
const cookieParser = require('cookie-parser'); // ⭐️ 자동 로그인을 위한 쿠키 파서 추가
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser()); // 쿠키 미들웨어 적용

// ⭐️ 환경변수(.env)에서 API 키를 안전하게 불러옵니다.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const NAVER_AUTH_KEY = process.env.NAVER_AUTH_KEY;

// ⭐️ 관리자 정보 (요청하신 아이디/비밀번호로 업데이트)
const ADMIN_ID = process.env.ADMIN_ID || 'haewoo';
const ADMIN_PW = process.env.ADMIN_PW || 'haewoo12!';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// 대화 기록 저장을 위한 객체 추가
const chatMemory = {};

// ==========================================
// ⚙️ 관리자 설정 변수 (기본값 세팅)
// ==========================================
let aiMode = 'off'; // 'on'(영업 외 시간 AI 가동), 'off'(수동 응대)
let testMode = 'off'; // ⭐️ 테스트 모드 변수 추가 ('on'일 경우 !테스트만 응답)
let activeStartHour = 19; // DB 호환용 유지 (사용 안 함)
let activeEndHour = 10;   // DB 호환용 유지 (사용 안 함)

let currentPrompt = `[시스템 역할 및 기본 원칙]
당신은 '해우렌탈(해우카메라)'의 영업시간 외 상담사입니다. 
- 본인이 AI임을 절대 밝히지 않으며, 항상 존댓말을 사용합니다.
- 추측성 답변(재고 여부, 예약 확정 등)을 절대 하지 않으며, 정책에 없는 내용을 지어내지 않습니다.
- 아래의 [CASE 1~5] 중 고객의 문의에 해당하는 단 하나의 CASE만 선택하여 처리하고, 지정된 응답만 출력합니다. (두 개 이상의 CASE 혼합 불가)

---

[고객 문의 분류 및 대응 매뉴얼 (★우선순위 순)]

■ CASE 1. 예약 및 대여 문의 (★가장 중요)
- 고객의 문장에 '대여, 예약, 렌탈, 재고, 카메라/렌즈 기종명' 중 하나라도 포함되어 있다면 무조건 CASE 1로 분류합니다. (절대 CASE 5로 보내지 마세요)

  1) 필수 정보 완벽성 검증:
     - 예약에 필요한 5가지 필수 정보: [1.기종, 2.수령 방법, 3.반납 방법, 4.정확한 수령 날짜와 시간, 5.정확한 반납 날짜와 시간]
     - ('대면, 직접, 퀵'은 '방문'으로 간주합니다.)
  
  2) CASE 1 최종 출력 (아래 2가지 중 택 1):
     - 🚨 [조건 A: 5가지 필수 정보 중 하나라도 빠져있거나, 특히 '방문'인데 정확한 '시간(OO시)'이 없는 경우 -> 묻지 말고 무조건 아래 양식 출력]:
       "정확한 재고 확인을 위해 아래 양식을 복사하여 작성해 주세요.
       
       ■ 대여 기종 :
       ■ 수령/반납 유형 (방문 / 무인 / 택배)
       (수령-00 / 반납-00)
       
       [방문/무인 일정]
       수령 : O월 O일 OO시 OO분
       반납 : O월 O일 OO시 OO분
       
       [택배 일정] (최소 3일 이상 주문 가능)
       수령 : O월 O일
       반납 : O월 O일"
       
     - ✅ [조건 B: 고객이 5가지 필수 정보(방문 시 정확한 시간 포함)를 모두 완벽하게 작성하여 보낸 경우 -> 아래 접수 멘트만 출력]:
       "[예약 문의] 기재해주신 내용을 바탕으로, 영업시간에 담당자가 재고 확인 후 순차적으로 안내해 드리겠습니다.
       * 해당 문자는 예약확정 문자가 아니며, 재고마감 시 대여가 불가 할 수 있다는점을 알려드립니다.
       
       [영업시간]
       월~금 : 10:00 ~ 18:20 (브레이크타임 15:00~16:00)
       토요일 : 10:00 ~ 14:00
       일요일 / 공휴일 : 휴무"

■ CASE 2. 긴급 상황 (고장, 파손, 분실, 침수, 작동 에러 등)
- 출력 멘트: "[긴급] 담당자 확인 후 바로 연락드리겠습니다."

■ CASE 3. 반납 주소 문의 (택배 보낼 곳, 주소 등)
- 출력 멘트 (★줄바꿈 유지):
  "안전한 반납을 위해 주소 안내드립니다.
  
  📍 경기도 수원시 권선구 세화로168번길 12 정안빌딩 2층 해우카메라 (전영대)
  📞 010-4607-0732
  
  ✔️ 우체국 택배만 가능합니다. (타 택배 불가)
  ✔️ 보내시는 분 란에는 예약자 성함과 연락처를 반드시 기재해 주세요."

■ CASE 4. 주차 문의
- 출력 멘트: "사무실 옆 주차 공간이 있습니다. 만차인 경우에는 도로에 잠시 비상등을 켜두시고 수령 및 반납하시면 됩니다."

■ CASE 5. 기타 단순 문의 (인사, 대답, 결제 통보 등 CASE 1~4에 해당하지 않는 경우)
- (★주의: 대여나 기종을 묻는 질문은 절대 이 CASE로 오면 안 됩니다.)
- 출력 멘트 (★줄바꿈 유지):
  "현재는 영업이 종료되어 즉시 확인이 어렵습니다.
  남겨주신 내용은 담당자가 영업시간에 확인 후 순차적으로 안내드리겠습니다.
  
  [영업시간]
  월~금 : 10:00~15:00 / 16:00~18:10 (브레이크타임 15:00~16:00)
  토요일 : 10:00~14:00
  일요일 / 공휴일 : 휴무"
  (*단, 고객이 결제/입금/주문 완료를 언급한 경우, 맨 위에 "사전 상담 없는 결제 건은 취소될 수 있습니다."를 반드시 추가할 것)

---

[🚨 절대 금지 및 출력 규칙]
- "확인했습니다, 문의 감사합니다" 등의 불필요한 인사말이나 요약 설명을 일절 금지합니다.
- 고객이 양식을 다 채우지 않았을 때 "시간을 알려주세요"라고 구두로 묻지 말고, 무조건 [조건 A]의 빈 양식을 통째로 띄우세요.
- 지정된 결과 멘트만 있는 그대로 출력하며, 멘트의 줄바꿈 형태를 임의로 훼손하지 마세요.`;

// ⭐️ Supabase DB에서 최신 데이터 가져오는 함수
async function loadSettingsFromDB() {
  try {
    const { data, error } = await supabase
      .from('bot_settings')
      .select('*')
      .eq('id', 1)
      .single();

    if (error) throw error;

    if (data) {
      aiMode = data.ai_mode || 'off';
      testMode = data.test_mode || 'off'; // DB에서 테스트 모드도 불러옴
      activeStartHour = data.active_start_hour;
      activeEndHour = data.active_end_hour;
      currentPrompt = data.current_prompt;
      console.log(`✅ Supabase 최신 설정 로드 완료 (현재 모드: ${aiMode} / 테스트: ${testMode})`);
    }
  } catch (err) {
    console.error('❌ DB 로드 실패 (기본 하드코딩 값으로 작동):', err.message);
  }
}

// ==========================================
// 🔐 [보안 미들웨어] - 전용 로그인 및 세션(쿠키) 관리
// ==========================================
// 관리자 페이지에 접근할 때 로그인이 되어있는지 확인하는 방어막
function requireAuth(req, res, next) {
  if (req.cookies.auth_token === 'authenticated') {
    return next();
  }
  res.redirect('/admin/login');
}

// 🔑 커스텀 로그인 페이지 렌더링
app.get('/admin/login', (req, res) => {
  if (req.cookies.auth_token === 'authenticated') {
    return res.redirect('/admin');
  }
  res.send(`
    <!DOCTYPE html>
    <html lang="ko">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>해우렌탈 로그인</title>
      <link rel="stylesheet" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css">
      <style>
        :root { --primary-color: #03c75a; --bg-color: #f2f4f6; }
        * { box-sizing: border-box; font-family: 'Pretendard Variable', sans-serif; }
        body { background: var(--bg-color); display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .login-box { background: #fff; padding: 40px; border-radius: 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); width: 100%; max-width: 360px; text-align: center; }
        h2 { margin-bottom: 24px; color: #191f28; }
        input[type="text"], input[type="password"] { width: 100%; padding: 14px; margin-bottom: 12px; border: 1px solid #ddd; border-radius: 10px; font-size: 15px; outline: none; transition: 0.2s; }
        input[type="text"]:focus, input[type="password"]:focus { border-color: var(--primary-color); }
        .options { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; font-size: 14px; color: #666; }
        .options label { display: flex; align-items: center; cursor: pointer; }
        .options input[type="checkbox"] { margin-right: 6px; }
        button { width: 100%; padding: 16px; background: var(--primary-color); color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: bold; cursor: pointer; }
        button:hover { background: #02b350; }
      </style>
    </head>
    <body>
      <div class="login-box">
        <h2>관리자 로그인</h2>
        <form action="/admin/login" method="POST">
          <input type="text" name="id" placeholder="아이디" required>
          <input type="password" name="pw" placeholder="비밀번호" required>
          <div class="options">
            <label><input type="checkbox" name="remember" value="true" checked> 자동 로그인 (30일 유지)</label>
          </div>
          <button type="submit">로그인</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

// 🔑 로그인 요청 처리 라우터
app.post('/admin/login', (req, res) => {
  const { id, pw, remember } = req.body;
  
  if (id === ADMIN_ID && pw === ADMIN_PW) {
    const cookieOptions = { httpOnly: true };
    // 자동 로그인을 체크했다면 쿠키 수명을 30일로 설정, 안 했으면 브라우저 종료 시 삭제
    if (remember === 'true') {
      cookieOptions.maxAge = 30 * 24 * 60 * 60 * 1000; 
    }
    res.cookie('auth_token', 'authenticated', cookieOptions);
    res.redirect('/admin');
  } else {
    res.send(`<script>alert('아이디 또는 비밀번호가 틀렸습니다.'); window.location.href='/admin/login';</script>`);
  }
});

// 🔑 로그아웃 처리
app.get('/admin/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.redirect('/admin/login');
});

// ==========================================
// 🎨 [관리자 페이지 라우터] - requireAuth로 보호됨
// ==========================================
app.get('/admin', requireAuth, (req, res) => {
  const html = `
    <!DOCTYPE html>
    <html lang="ko">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <title>해우렌탈 AI 관리자</title>
      <link rel="stylesheet" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css">
      <style>
        :root { --bg-color: #f2f4f6; --card-bg: #ffffff; --text-primary: #191f28; --text-secondary: #8b95a1; --primary-color: #03c75a; --border-radius: 16px; }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Pretendard Variable', sans-serif; }
        body { background-color: var(--bg-color); color: var(--text-primary); -webkit-font-smoothing: antialiased; display: flex; justify-content: center; padding: 20px; }
        .container { width: 100%; max-width: 600px; }
        .header { margin-bottom: 24px; margin-top: 20px; text-align: center; position: relative; }
        .header h1 { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; cursor: pointer; user-select: none; }
        .header p { color: var(--text-secondary); margin-top: 6px; font-size: 14px; }
        .logout-btn { position: absolute; right: 0; top: 0; font-size: 12px; color: #888; text-decoration: none; padding: 6px 12px; background: #e9ecef; border-radius: 8px; }
        .section { background: var(--card-bg); border-radius: var(--border-radius); padding: 24px; box-shadow: 0 4px 12px rgba(0,0,0,0.03); margin-bottom: 20px; }
        .section-title { font-size: 16px; font-weight: 700; margin-bottom: 16px; color: var(--text-primary); }
        .form-group { margin-bottom: 0; }
        textarea { width: 100%; background: #f9f9f9; border: 1px solid #e0e0e0; border-radius: 12px; padding: 16px; font-size: 14px; color: var(--text-primary); transition: all 0.2s ease; outline: none; height: 350px; resize: vertical; line-height: 1.6; }
        textarea:focus { background: #ffffff; border-color: var(--primary-color); box-shadow: 0 0 0 3px rgba(3, 199, 90, 0.1); }
        .btn-submit { width: 100%; background: var(--primary-color); color: white; border: none; border-radius: 14px; padding: 18px; font-size: 16px; font-weight: 700; cursor: pointer; transition: background 0.2s; margin-bottom: 30px; }
        .btn-submit:active { background: #02b350; transform: scale(0.98); }
        
        /* 토글 스위치 디자인 */
        .toggle-container { display: flex; align-items: center; justify-content: space-between; background: #f8f9fa; padding: 16px; border-radius: 12px; margin-bottom: 10px; }
        .toggle-text strong { display: block; font-size: 15px; margin-bottom: 4px; color: #222; }
        .toggle-text span { font-size: 12px; color: var(--text-secondary); }
        .switch { position: relative; display: inline-block; width: 56px; height: 32px; flex-shrink: 0; }
        .switch input { opacity: 0; width: 0; height: 0; }
        .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #d1d1d6; transition: .3s; border-radius: 34px; }
        .slider:before { position: absolute; content: ""; height: 24px; width: 24px; left: 4px; bottom: 4px; background-color: white; transition: .3s; border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
        input:checked + .slider { background-color: var(--primary-color); }
        input:checked + .slider:before { transform: translateX(24px); }
        
        /* ⭐️ 테스트 모드 (이스터에그) 컨테이너 (기본 숨김) */
        #test-mode-container { display: ${testMode === 'on' ? 'flex' : 'none'}; background: #fff3cd; border: 1px solid #ffe69c; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <!-- ⭐️ 이스터에그 발동을 위한 ID 추가 -->
          <h1 id="admin-title">해우시스템 AI 제어 센터</h1>
          <p>해우렌탈 스마트 자동응답 시스템 설정</p>
          <a href="/admin/logout" class="logout-btn">로그아웃</a>
        </div>
        <form action="/admin/update" method="POST">
          
          <div class="section">
            <div class="section-title">🤖 AI 운영 상태</div>
            
            <div class="toggle-container">
              <div class="toggle-text">
                <strong>AI 자동응답 켜기</strong>
                <span>ON: 영업시간 외 AI 응대 / OFF: 수동 응대</span>
              </div>
              <label class="switch">
                <input type="checkbox" name="aiModeToggle" value="on" ${aiMode === 'on' ? 'checked' : ''}>
                <span class="slider"></span>
              </label>
            </div>

            <!-- ⭐️ 이스터에그: 숨겨진 테스트 모드 영역 -->
            <div class="toggle-container" id="test-mode-container">
              <div class="toggle-text">
                <strong>🛠️ 개발자 테스트 모드</strong>
                <span>'!테스트'로 시작하는 문장에만 AI가 답변합니다.</span>
              </div>
              <label class="switch">
                <input type="checkbox" id="testToggleInput" name="testModeToggle" value="on" ${testMode === 'on' ? 'checked' : ''}>
                <span class="slider"></span>
              </label>
            </div>
          </div>

          <div class="section">
            <div class="section-title">📝 AI 정책 프롬프트</div>
            <div class="form-group">
              <textarea name="promptText" spellcheck="false">${currentPrompt}</textarea>
            </div>
          </div>

          <button type="submit" class="btn-submit">변경사항 저장하기</button>
        </form>
      </div>

      <!-- ⭐️ 이스터에그 동작 스크립트 -->
      <script>
        const titleEl = document.getElementById('admin-title');
        const testContainer = document.getElementById('test-mode-container');
        const testToggleInput = document.getElementById('testToggleInput');
        let clickCount = 0;

        titleEl.addEventListener('click', () => {
          clickCount++;
          const isHidden = (testContainer.style.display === 'none' || testContainer.style.display === '');
          
          if (isHidden && clickCount >= 8) {
            testContainer.style.display = 'flex';
            clickCount = 0;
            alert('🛠️ 개발자 테스트 모드가 활성화되었습니다.');
          } else if (!isHidden && clickCount >= 3) {
            testContainer.style.display = 'none';
            testToggleInput.checked = false; // 숨길 때 체크 해제
            clickCount = 0;
          }
        });
      </script>
    </body>
    </html>
  `;
  res.send(html);
});

// ⭐️ 관리자 설정 변경 라우터 (DB 동기화) - requireAuth로 보호됨
app.post('/admin/update', requireAuth, async (req, res) => {
  aiMode = req.body.aiModeToggle === 'on' ? 'on' : 'off';
  testMode = req.body.testModeToggle === 'on' ? 'on' : 'off'; // 테스트 모드 상태도 저장
  currentPrompt = req.body.promptText;
  
  try {
    const { error } = await supabase
      .from('bot_settings')
      .update({
        ai_mode: aiMode,
        test_mode: testMode,
        current_prompt: currentPrompt
      })
      .eq('id', 1);

    if (error) throw error;
    console.log(`⚙️ 관리자 설정 변경 완료 (모드: ${aiMode} / 테스트: ${testMode})`);
  } catch (err) {
    console.error('❌ Supabase DB 업데이트 실패:', err.message);
  }

  res.redirect('/admin'); 
});

// ==========================================
// 🤖 [네이버 톡톡 웹훅] - 실전 도입 버전
// ==========================================
app.post('/webhook', async (req, res) => {
  const event = req.body;
  res.status(200).send('SUCCESS');

  if (event.event === 'send') {
    const userMessage = event.textContent.text; 
    const inputType = event.textContent.inputType; 
    const userHash = event.user;

    // 버튼 클릭 시 AI 무시
    if (inputType === 'button') {
      console.log(`🔘 [버튼 클릭 감지] 톡톡챗봇 메뉴. AI 응대 무시.`);
      return; 
    }
// ==========================================
    // 🔍 [응답 조건 로직: 우선순위 1.AI모드 / 2.개발자모드]
    // ==========================================
    let realMessage = userMessage;

    if (aiMode === 'on') {
      // [조건 1 & 2] AI 모드 ON: 개발자 모드 상태와 무관하게 모든 문의에 응답
      console.log(`✅ [AI 모드 ON] 고객 메시지 수신 처리 중...`);
      
      // (편의 기능) AI 모드가 ON일 때 대표님이 습관적으로 '!테스트'를 치더라도 정상 답변하도록 처리
      if (userMessage.startsWith('!테스트')) {
        realMessage = userMessage.replace(/^!테스트\s*/, '').trim();
      }
    } else {
      // [조건 3 & 4] AI 모드 OFF
      if (testMode === 'on') {
        // [조건 3] AI 모드 OFF, 개발자 모드 ON: '!테스트' 입력 시에만 동작
        if (!userMessage.startsWith('!테스트')) {
          console.log(`🚫 [AI OFF / 테스트 ON] 일반 고객 메시지 완벽 방어`);
          return; // 일반 문의 차단
        }
        // '!테스트'가 확인되면 글자를 떼어내고 통과
        realMessage = userMessage.replace(/^!테스트\s*/, '').trim();
        console.log(`🛠️ [AI OFF / 테스트 ON] 개발자 테스트 명령어 인식 완료`);
      } else {
        // [조건 4] AI 모드 OFF, 개발자 모드 OFF: 모든 문의 무시
        console.log(`⏸️ [AI OFF / 테스트 OFF] 시스템 대기 상태. 모든 메시지 무시`);
        return; // 완전 차단
      }
    }

    // --- 대화 기억(Memory) 로직 ---
    if (!chatMemory[userHash]) {
      chatMemory[userHash] = []; 
    }

    // 테스트 글자를 떼어낸 'realMessage'를 기억소자(DB)에 넣음
    chatMemory[userHash].push({ role: "user", content: realMessage });

    if (chatMemory[userHash].length > 6) {
      chatMemory[userHash].shift();
    }

    try {
      const messagesToSend = [
        { role: "system", content: currentPrompt },
        ...chatMemory[userHash] 
      ];

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: messagesToSend,
      });

      const aiResponse = completion.choices[0].message.content;
      console.log(`🤖 AI 응답 발송 완료 [고객 해시: ${userHash}]`);

      chatMemory[userHash].push({ role: "assistant", content: aiResponse });

      await fetch('https://gw.talk.naver.com/chatbot/v1/event', {
        method: 'POST',
        headers: {
          'Authorization': NAVER_AUTH_KEY,
          'Content-Type': 'application/json;charset=UTF-8'
        },
        body: JSON.stringify({
          event: "send",
          user: userHash,
          textContent: { text: aiResponse }
        })
      });

    } catch (error) {
      console.error("❌ OpenAI 또는 네이버 API 통신 오류 발생:", error);
    }
  }
});

// ⭐️ 서버 구동
app.listen(3000, async () => {
  console.log('==============================================');
  console.log('🚀 해우렌탈 최종 실전 서버 구동 중...');
  await loadSettingsFromDB(); 
  console.log(`👉 http://localhost:3000/admin`);
  console.log('==============================================');
});