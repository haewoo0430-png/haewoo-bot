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
let aiMode = 'schedule'; // 'always_on'(24시간 가동), 'schedule'(스케줄 작동), 'always_off'(완전 종료)
let activeStartHour = 19; 
let activeEndHour = 10;   

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
      aiMode = data.ai_mode || 'schedule';
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
// 🎨 [관리자 페이지 라우터] - 모바일 최적화 적용
// ==========================================
app.get('/admin', (req, res) => {
  const html = `
    <!DOCTYPE html>
    <html lang="ko">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>해우렌탈 AI 관리자</title>
      <link rel="stylesheet" crossorigin href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css">
      <style>
        :root { --bg-color: #f2f4f6; --card-bg: #ffffff; --text-primary: #191f28; --text-secondary: #8b95a1; --primary-color: #3182f6; --border-radius: 16px; }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Pretendard Variable', sans-serif; }
        body { background-color: var(--bg-color); color: var(--text-primary); -webkit-font-smoothing: antialiased; display: flex; justify-content: center; padding: 40px 20px; }
        .container { width: 100%; max-width: 600px; }
        .header { margin-bottom: 28px; }
        .header h1 { font-size: 26px; font-weight: 700; letter-spacing: -0.5px; }
        .header p { color: var(--text-secondary); margin-top: 6px; font-size: 15px; }
        .section { background: var(--card-bg); border-radius: var(--border-radius); padding: 28px 24px; box-shadow: 0 2px 14px rgba(0,0,0,0.03); margin-bottom: 20px; }
        .section-title { font-size: 18px; font-weight: 700; margin-bottom: 12px; color: var(--text-primary); }
        .form-group { margin-bottom: 24px; }
        .form-label { display: block; font-size: 14px; font-weight: 600; color: var(--text-secondary); margin-bottom: 10px; }
        input[type="number"], textarea { width: 100%; background: #f2f4f6; border: 1px solid transparent; border-radius: 12px; padding: 14px 16px; font-size: 15px; color: var(--text-primary); transition: all 0.2s ease; outline: none; }
        input[type="number"]:focus, textarea:focus { background: #ffffff; border-color: var(--primary-color); box-shadow: 0 0 0 3px rgba(49, 130, 246, 0.1); }
        textarea { height: 320px; resize: vertical; line-height: 1.6; }
        .time-wrap { display: flex; align-items: center; gap: 12px; background: #f2f4f6; padding: 12px 16px; border-radius: 12px; }
        .time-wrap input { width: 60px; text-align: center; background: white; border: 1px solid #e5e8eb; padding: 8px; border-radius: 8px; }
        .btn-submit { width: 100%; background: var(--primary-color); color: white; border: none; border-radius: 14px; padding: 18px; font-size: 16px; font-weight: 700; cursor: pointer; transition: background 0.2s; }
        .btn-submit:hover { background: #1b64da; }
        
        /* ⭐️ 모바일 친화적 라디오 버튼 스타일 */
        .radio-group { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
        .radio-label { display: flex; align-items: center; padding: 14px 16px; background: #f2f4f6; border-radius: 12px; cursor: pointer; border: 2px solid transparent; transition: all 0.2s; font-weight: 600; font-size: 15px; }
        .radio-label:has(input:checked) { background: #ffffff; border-color: var(--primary-color); box-shadow: 0 4px 12px rgba(49, 130, 246, 0.15); color: var(--primary-color); }
        .radio-label input { display: none; }
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
            <div class="form-group">
              <div class="section-title">🤖 AI 운영 모드 선택</div>
              <div class="radio-group">
                <label class="radio-label">
                  <input type="radio" name="aiMode" value="always_on" ${aiMode === 'always_on' ? 'checked' : ''}>
                  🟢 24시간 풀가동 (점심시간 / 바쁠 때)
                </label>
                <label class="radio-label">
                  <input type="radio" name="aiMode" value="schedule" ${aiMode === 'schedule' ? 'checked' : ''}>
                  🟡 스케줄 작동 (설정한 시간에만 작동)
                </label>
                <label class="radio-label">
                  <input type="radio" name="aiMode" value="always_off" ${aiMode === 'always_off' ? 'checked' : ''}>
                  🔴 완전 종료 (관리자 수동 대화 시)
                </label>
              </div>
            </div>

            <div class="form-group" style="margin-bottom: 0; margin-top: 30px;">
              <label class="form-label">스케줄 작동 시간 (시작 ~ 종료)</label>
              <div class="time-wrap">
                <input type="number" name="activeStartHour" value="${activeStartHour}" min="0" max="23">
                <span>시 부터</span>
                <input type="number" name="activeEndHour" value="${activeEndHour}" min="0" max="23">
                <span>시 까지 작동</span>
              </div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">📝 AI 정책 프롬프트</div>
            <div class="form-group" style="margin-bottom: 0;">
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
  aiMode = req.body.aiMode; 
  activeStartHour = parseInt(req.body.activeStartHour);
  activeEndHour = parseInt(req.body.activeEndHour);
  currentPrompt = req.body.promptText;
  
  try {
    const { error } = await supabase
      .from('bot_settings')
      .update({
        ai_mode: aiMode,
        active_start_hour: activeStartHour,
        active_end_hour: activeEndHour,
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
// 🤖 [네이버 톡톡 웹훅] - 3단계 모드 적용
// ==========================================
app.post('/webhook', async (req, res) => {
  const event = req.body;
  res.status(200).send('SUCCESS');

  if (event.event === 'send') {
    const userMessage = event.textContent.text; 
    const inputType = event.textContent.inputType; 
    const userHash = event.user;

    if (inputType === 'button') {
      console.log(`🔘 [버튼 클릭 감지] 톡톡챗봇 메뉴. AI 응대 무시.`);
      return; 
    }

    if (!userMessage.startsWith("!테스트")) return;
    const realMessage = userMessage.replace("!테스트 ", "");

    if (aiMode === 'always_off') return; 

    let isTimeActive = false;
    if (aiMode === 'always_on') {
      isTimeActive = true; 
    } else if (aiMode === 'schedule') {
      const currentHour = new Date().getHours();
      if (activeStartHour > activeEndHour) {
        isTimeActive = (currentHour >= activeStartHour || currentHour < activeEndHour);
      } else {
        isTimeActive = (currentHour >= activeStartHour && currentHour < activeEndHour);
      }
    }

    if (!isTimeActive) return; 

    // ⭐️ [핵심 수정] 사용자별 대화 기록 배열 초기화
    if (!chatMemory[userHash]) {
      chatMemory[userHash] = []; 
    }

    // 사용자의 새 메시지를 기억에 추가
    chatMemory[userHash].push({ role: "user", content: realMessage });

    // 토큰 비용 절약 및 과부하 방지를 위해 최근 대화 6개(질문3+답변3)만 유지
    if (chatMemory[userHash].length > 6) {
      chatMemory[userHash].shift();
    }

    try {
      // ⭐️ [핵심 수정] system 프롬프트 + 이전 대화 기록을 통째로 OpenAI에 전달
      const messagesToSend = [
        { role: "system", content: currentPrompt },
        ...chatMemory[userHash] 
      ];

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: messagesToSend,
      });

      const aiResponse = completion.choices[0].message.content;
      console.log(`🤖 AI 응답 발송 완료 [모드: ${aiMode}]`);

      // ⭐️ AI의 답변도 다음 문맥 파악을 위해 기억에 추가
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