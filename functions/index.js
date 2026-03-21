// functions/index.js
// Firebase Cloud Functions — 메일 알림 스케줄러
// 
// 설치:
//   cd functions && npm install
//   firebase deploy --only functions
//
// 필요한 환경변수 설정:
//   firebase functions:secrets:set GMAIL_USER
//   firebase functions:secrets:set GMAIL_PASS

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const nodemailer = require("nodemailer");
const { defineSecret } = require("firebase-functions/params");

initializeApp();
const db = getFirestore();

const GMAIL_USER = defineSecret("GMAIL_USER");
const GMAIL_PASS = defineSecret("GMAIL_PASS");

// 매일 오전 8시 (KST = UTC+9, so 23:00 UTC 전날)
exports.dailyMailAlert = onSchedule(
  {
    schedule: "0 23 * * *",   // UTC 기준 23:00 = KST 08:00
    timeZone: "Asia/Seoul",
    secrets: [GMAIL_USER, GMAIL_PASS],
  },
  async () => {
    const today = new Date().toISOString().split("T")[0];

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: GMAIL_USER.value(),
        pass: GMAIL_PASS.value(),  // Gmail 앱 비밀번호 사용
      },
    });

    // 모든 유저 순회
    const usersSnap = await db.collection("users").get();

    for (const userDoc of usersSnap.docs) {
      const userData = userDoc.data();
      const uid = userDoc.id;
      const email = userData.email;
      if (!email) continue;

      // 유저의 모든 아이 순회
      const childrenSnap = await db
        .collection("users").doc(uid)
        .collection("children").get();

      for (const childDoc of childrenSnap.docs) {
        const child = childDoc.data();
        const todos = child.todos || [];
        if (!todos.length) continue;

        // 마지막 todo 날짜를 lastTodoDate 필드로 관리
        // (설정에서 엄마가 입력하거나 월 마지막날 자동 설정)
        const lastDate = child.lastTodoDate;
        if (!lastDate) continue;

        // 마지막 날 +1일이 오늘이면 메일 발송
        const nextDay = new Date(lastDate);
        nextDay.setDate(nextDay.getDate() + 1);
        const nextDayStr = nextDay.toISOString().split("T")[0];

        if (nextDayStr !== today) continue;

        // 메일 발송
        await transporter.sendMail({
          from: `Play Routine <${GMAIL_USER.value()}>`,
          to: email,
          subject: `[Play Routine] ${child.name} 일정이 끝났어요 — 다음 일정을 추가해주세요`,
          html: `
            <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 20px">
              <h2 style="color:#a78bfa;margin-bottom:8px">Play Routine</h2>
              <p style="font-size:16px;font-weight:700;margin-bottom:16px">
                ${child.name}의 이번 달 일정이 마무리됐어요 🎉
              </p>
              <div style="background:#1c1c27;border-radius:12px;padding:16px;margin-bottom:20px">
                <div style="font-size:13px;color:#6b6b90;margin-bottom:4px">현재 잔액</div>
                <div style="font-size:28px;font-weight:700;color:#5eead4;font-family:monospace">
                  ${Math.floor((child.totalMinutes||0)/60)}h ${(child.totalMinutes||0)%60}min
                </div>
              </div>
              <p style="font-size:14px;color:#6b6b90;line-height:1.8">
                다음 달 일정과 목표를 앱에서 설정해주세요.<br>
                아이와 함께 새 목표를 정하는 시간을 가져보세요!
              </p>
              <a href="https://play-routine-39981.web.app"
                style="display:inline-block;margin-top:20px;padding:12px 24px;
                background:#a78bfa;color:#0d0d12;border-radius:10px;
                text-decoration:none;font-weight:700;font-size:14px">
                앱 열기 →
              </a>
              <p style="font-size:11px;color:#44445a;margin-top:32px">
                Play Routine · 수신거부는 앱 설정에서 변경할 수 있습니다
              </p>
            </div>
          `,
        });

        console.log(`Mail sent to ${email} for child ${child.name}`);
      }
    }
  }
);