import axios from "axios";

const arkesel_key = process.env.ARKESEL_KEY;

const sendSMSMessage = async (message, contacts) => {
  const filteredContacts = contacts.filter(contact => /^\d{10}$/.test(contact));

  const data = {
    sender: "PPeace Sch",
    message: message,
    recipients: filteredContacts,
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