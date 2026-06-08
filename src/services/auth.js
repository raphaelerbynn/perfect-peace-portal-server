import axios from "axios";
import { SMS_SENDER_ID } from "./messaging.js";

const arkesel_key = process.env.ARKESEL_KEY;

const sendPasswordConfirmationCode = async (code, contact) => {
  const data = {
    // BE-3: single registered sender ID.
    sender: SMS_SENDER_ID,
    message: `Your password reset code is ${code}`,
    recipients: [contact],
  };

  const config = {
    method: "post",
    url: "https://sms.arkesel.com/api/v2/sms/send",
    headers: {
      "api-key": arkesel_key,
    },
    data: data,
    // BE-7: bound the provider call so a hung Arkesel can't hang the OTP request.
    timeout: 10000,
  };

  // BE-8: handle provider failure WITHOUT leaking the axios error (its config
  // carries the api-key header). Surface a clean error to the caller.
  try {
    const response = await axios(config);
    return response.data;
  } catch (error) {
    throw new Error("Failed to send password reset code, please try again");
  }
};

export { sendPasswordConfirmationCode };
