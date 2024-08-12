import axios from "axios";

const arkesel_key = process.env.ARKESEL_KEY;

const sendSMSMessage = async (message, contacts) => {

  const data = {
    sender: "PPeace Sch",
    message: message,
    recipients: contacts,
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



export { sendSMSMessage };