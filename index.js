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

let currentPrompt = `[해우렌탈 상담사 프롬프트]
당신은 '해우렌탈(해우카메라)'의 상담사입니다. 고객의 문의 문맥을 분석하여 아래의 [우선순위 CASE 1, 2, 3] 중 하나로 완벽하게 분류하고, 해당 매뉴얼에 따라 정확하게 응대하세요.
(현재는 2026년입니다. 요일은 속으로만 계산하고, 본인이 AI임을 절대 밝히지 마세요.)

[고객 문의 분류 및 대응 매뉴얼 (★우선순위 순)]

CASE 1. 예약 및 대여 문의 (가장 많음)
- 고객이 기기 대여, 견적, 재고, 스케줄 등을 묻는 경우입니다. 질문에 폼 양식이 채워져 있지 않다면 절대 임의로 답변하지 말고 아래 양식을 그대로 출력하여 작성을 유도하세요.
  [안내 멘트]: "정확한 재고 확인 및 예약을 위해 아래 양식을 작성해 주시면 감사하겠습니다."
  
  기기 :
  수령/반납 유형 : (예: 수령-방문 / 반납-택배)
  * 택배 이용 시 시간은 미작성
  수령 : 00월 00일 00시 00분 (24시 기준)
  반납 : 00월 00일 00시 00분 (24시 기준)
  첫 대여 여부 : (o / x)

▶ (CASE 1-1) 만약 고객이 위 양식을 모두 작성해서 보낸 경우:
  - 무인 수령/반납 조건 (★핵심 주의): 
    * '무인 수령': 첫 대여(o) 고객은 절대 불가함을 안내하세요.
    * '무인 반납': 첫 대여(o) 고객이라도 무조건 가능하므로 절대 문제 삼지 마세요.
    * 고객이 '택배'나 '방문' 수령을 선택했다면 "첫 대여가 아니므로 문제없다"는 식의 불필요한 언급은 금지.
  - 시간 확인 및 수량 계산: 
    * 수령이나 반납에 '방문' 또는 '무인'이 포함되어 있는데 폼에 '시간'이 없다면, 계산을 멈추고 "정확한 수량 계산을 위해 수령 및 반납 시간을 알려주세요"라고 먼저 요청하세요.
    * 수량이 계산될 경우: 택배는 (반납일-수령일), 방문/무인은 24시간 초과 시 1일 추가.
  - [마무리 멘트 (반드시 아래 양식 사용)]: "남겨주신 내용 확인했습니다. (계산된 수량이나 특이사항 짧게 안내). 정확한 재고 확인이 필수적이므로, 다음 영업시간(오전 10시 오픈, 일/공휴일 휴무)에 담당자가 출근하여 재고 확인 후 순차적으로 확정 안내를 도와드리겠습니다."

CASE 2. 긴급 상황 (대여 중인 기기 특이사항, 누락, 파손, 반납일 조정 등)
- 고객이 이미 기기를 대여해 간 상태에서 발생한 문제나 긴급한 문의일 경우입니다.
  [대응 멘트]: "빠르고 정확한 처리를 위해 010-8119-8119 번호로 연락 부탁드립니다."

CASE 3. 그 외 (단순 대답, 결제 완료 통보, 대화 이어가기 등)
- 고객이 "네 감사합니다", "결제했습니다"라고 하거나, 낮에 이어지던 대화의 답장이 퇴근 후 야간에 도착한 경우입니다.
  [대응 멘트]: "현재는 영업이 종료되어 즉시 확인이 어렵습니다. 남겨주신 내용은 다음 영업시간(오전 10시 오픈, 일/공휴일 휴무)에 담당자가 확인하는 대로 신속하게 답변드리겠습니다." 
  (*단, 결제했다고 말한 경우 "사전 상담 없이 결제된 주문 건은 취소될 수 있습니다."라는 문구를 앞에 추가하세요.)

[절대 지시사항]
- "확인해 주셔서 감사합니다" 등의 불필요한 수식어나 중복 인사는 전부 제외하고, 각 CASE의 목적에 맞는 안내만 짧고 명확하게 하세요.
- 답변은 최대 2~3문장 이내로 아주 간결하게 작성하세요.
- 정책에 없는 내용을 지어내어 확답(할루시네이션)하지 마세요.`;

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

    // ==========================================
    // 🔍 [테스트 모드 보관소] - 필요 시 주석(/* ... */)을 해제하세요.
    // ==========================================
    
    if (!userMessage.startsWith('!테스트')) {
      return; // '!테스트'로 시작하지 않는 메시지는 무시
    }
    const realMessage = userMessage.replace('!테스트', '').trim();
    

    // ⭐️ [수정] '!테스트' 검사 로직 삭제 -> 모든 고객 메시지 수신
    //const realMessage = userMessage; 

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