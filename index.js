const express = require('express');
const { OpenAI } = require('openai');
const basicAuth = require('express-basic-auth');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ⭐️ 환경변수(.env)에서 API 키를 안전하게 불러옵니다.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const NAVER_AUTH_KEY = process.env.NAVER_AUTH_KEY;

// ⭐️ 관리자 정보 및 Supabase 클라이언트 초기화 (보안 강화)
const ADMIN_ID = process.env.ADMIN_ID || 'admin';
const ADMIN_PW = process.env.ADMIN_PW || 'haewoo123!'; // 가급적 .env에 ADMIN_PW를 설정하세요
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// 대화 기록 저장을 위한 객체 추가
const chatMemory = {};

// ⭐️ 관리자 페이지 접속 암호 설정
app.use('/admin', basicAuth({
  users: { [ADMIN_ID]: ADMIN_PW },
  challenge: true,
  unauthorizedResponse: '접근 권한이 없습니다.'
}));

// ==========================================
// ⚙️ 관리자 설정 변수 (기본값 세팅)
// ==========================================
let aiMode = 'off'; // 'on'(영업 외 시간 AI 가동), 'off'(수동 응대)
let activeStartHour = 19; // DB 호환용 유지 (사용 안 함)
let activeEndHour = 10;   // DB 호환용 유지 (사용 안 함)

let currentPrompt = `[해우렌탈 AI 야간 상담사]
당신은 '해우렌탈(해우카메라)'의 AI 야간 상담사입니다. 고객에게 항상 친절하게 [해우카메라 AI 상담사]임을 밝히며 인사를 시작하고, 아래의 [사내 정책]을 완벽하게 숙지하여 답변하세요.

[사내 정책]
1. 기본 정보 및 영업시간
- 위치: 경기도 수원시 권선구 세화로168번길 12 2층 해우카메라 (수원역 환승센터 도보 5분)
- 영업시간: 평일 10:00 ~ 18:10 (브레이크타임 15:00~16:00), 토요일 10:00 ~ 13:50 (일/공휴일 휴무)
- 주의: 현재는 업무 종료 상태이므로, 스케줄 등 상세 문의 시 항상 '내일 오전 10시(또는 영업 시작 시간)'에 매니저가 확인 후 연락드린다고 안내할 것.
- 주차: 매장 옆 주차 가능. 만차 시 도로 비상등 켜고 수령.

2. 예약 및 스케줄 문의 (핵심 방어)
- 규칙: 기기 대여 가능 여부, 재고, 스케줄 등은 AI가 절대 임의로 확답하지 않는다. 
- 예약 필수: 결제 전 반드시 톡톡으로 사전 상담 필수 (미상담 결제 시 통보 없이 취소 가능).
- 질문 유도: 문의 시 "주문하실 상품 + 수령/반납 일자 + 수령 방법"을 남겨달라고 요청할 것.

3. 수령 및 반납 방법 (방문 / 택배 / 무인실)
- 방문: 결제자 본인만 수령 가능 (대리 수령 절대 불가). 
- 택배: 최소 3일 이상부터 주문 가능. 왕복 배송비 대여자 부담. 반납 시 우체국 택배를 통해 반납일 16시 30분 이전에 선불 발송 필수.
- 무인실: 24시간 운영되나, 첫 대여 고객은 무인 수령 불가. 일요일/공휴일은 수령 불가(반납만 가능).

4. 결제, 환불 및 연체 규정
- 취소/환불: 수령일 기준 3일 이내 취소/변경 시 50% 환불, 당일 취소 및 노쇼는 환불 불가.
- 연체: 반납 시간 초과 시 시간 요금이 아닌 1일 기준 대여료가 청구됨.

5. 기기 사용 및 파손 안내
- 데이터 백업: 메모리카드 데이터는 이전 후 '포맷 상태'로 반납.
- 파손 시: 추가 손상 방지를 위해 기기 전원을 켜지 말고 파손 부위 사진을 톡톡으로 남겨달라고 안내.

[절대 지시사항]
- 정책에 없는 내용은 지어내지(할루시네이션) 말고, 모르는 것은 내일 매니저에게 연결한다고 하세요.
- 답변은 항상 존댓말을 사용하세요.`;

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
      activeStartHour = data.active_start_hour;
      activeEndHour = data.active_end_hour;
      currentPrompt = data.current_prompt;
      console.log(`✅ Supabase 최신 설정 로드 완료 (현재 모드: ${aiMode})`);
    }
  } catch (err) {
    console.error('❌ DB 로드 실패 (기본 하드코딩 값으로 작동):', err.message);
  }
}

// ==========================================
// 🎨 [관리자 페이지 라우터] - 모바일 최적화 및 토글 적용
// ==========================================
app.get('/admin', (req, res) => {
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
        .header { margin-bottom: 24px; margin-top: 20px; text-align: center; }
        .header h1 { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
        .header p { color: var(--text-secondary); margin-top: 6px; font-size: 14px; }
        .section { background: var(--card-bg); border-radius: var(--border-radius); padding: 24px; box-shadow: 0 4px 12px rgba(0,0,0,0.03); margin-bottom: 20px; }
        .section-title { font-size: 16px; font-weight: 700; margin-bottom: 16px; color: var(--text-primary); }
        .form-group { margin-bottom: 0; }
        textarea { width: 100%; background: #f9f9f9; border: 1px solid #e0e0e0; border-radius: 12px; padding: 16px; font-size: 14px; color: var(--text-primary); transition: all 0.2s ease; outline: none; height: 350px; resize: vertical; line-height: 1.6; }
        textarea:focus { background: #ffffff; border-color: var(--primary-color); box-shadow: 0 0 0 3px rgba(3, 199, 90, 0.1); }
        .btn-submit { width: 100%; background: var(--primary-color); color: white; border: none; border-radius: 14px; padding: 18px; font-size: 16px; font-weight: 700; cursor: pointer; transition: background 0.2s; margin-bottom: 30px; }
        .btn-submit:active { background: #02b350; transform: scale(0.98); }
        
        /* ⭐️ 모바일 친화적 토글 스위치 디자인 */
        .toggle-container { display: flex; align-items: center; justify-content: space-between; background: #f8f9fa; padding: 16px; border-radius: 12px; }
        .toggle-text strong { display: block; font-size: 15px; margin-bottom: 4px; color: #222; }
        .toggle-text span { font-size: 12px; color: var(--text-secondary); }
        .switch { position: relative; display: inline-block; width: 56px; height: 32px; flex-shrink: 0; }
        .switch input { opacity: 0; width: 0; height: 0; }
        .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #d1d1d6; transition: .3s; border-radius: 34px; }
        .slider:before { position: absolute; content: ""; height: 24px; width: 24px; left: 4px; bottom: 4px; background-color: white; transition: .3s; border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
        input:checked + .slider { background-color: var(--primary-color); }
        input:checked + .slider:before { transform: translateX(24px); }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>해우시스템 AI 제어 센터</h1>
          <p>해우렌탈 스마트 자동응답 시스템 설정</p>
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
    </body>
    </html>
  `;
  res.send(html);
});

// ⭐️ 관리자 설정 변경 라우터 (DB 동기화)
app.post('/admin/update', async (req, res) => {
  // 체크박스가 ON이면 'on' 반환, 해제되어 있으면 undefined이므로 'off' 처리
  aiMode = req.body.aiModeToggle === 'on' ? 'on' : 'off';
  currentPrompt = req.body.promptText;
  
  try {
    const { error } = await supabase
      .from('bot_settings')
      .update({
        ai_mode: aiMode,
        current_prompt: currentPrompt
      })
      .eq('id', 1);

    if (error) throw error;
    console.log(`⚙️ 관리자 설정 변경 완료 (현재 모드: ${aiMode})`);
  } catch (err) {
    console.error('❌ Supabase DB 업데이트 실패:', err.message);
  }

  res.redirect('/admin'); 
});

// ==========================================
// 🤖 [네이버 톡톡 웹훅] - 실전 도입 버전 (!테스트 제거, ON/OFF 적용)
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

    // ⭐️ [수정] '!테스트' 검사 로직 삭제 -> 모든 고객 메시지 수신
    const realMessage = userMessage; 

    // ⭐️ [수정] 심플 ON/OFF 로직
    // aiMode가 'on'일 때만 작동 (영업시간 외 AI 응대 모드)
    // 'off'일 때는 아무것도 하지 않음 (관리자 수동 응대 모드)
    if (aiMode !== 'on') {
      console.log(`⏸️ AI 모드 OFF 상태. 응답 무시.`);
      return; 
    }

    // --- 대화 기억(Memory) 로직 ---
    if (!chatMemory[userHash]) {
      chatMemory[userHash] = []; 
    }

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
  console.log(`👉 http://localhost:3000/admin (ID: ${ADMIN_ID})`);
  console.log('==============================================');
});