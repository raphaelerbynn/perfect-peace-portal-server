import axios from "axios";

const arkesel_key = process.env.ARKESEL_KEY;

const sendPasswordConfirmationCode = async (code, contact) => {

  const data = {
    sender: "PPeace Sch",
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
  }; 

    const response = await axios(config);
    console.log(JSON.stringify(response.data));

    return response.data;
};

export { sendPasswordConfirmationCode };
