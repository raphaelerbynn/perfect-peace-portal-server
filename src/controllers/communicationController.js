import { sendSMSMessage } from "../services/messaging.js";

const sendSMS = async (req, res, next) => {
    const { contacts, message } = req.body;

    try {
      const response = await sendSMSMessage(message, contacts);
      console.log(response);

      res.status(200).send({
        message: "SMS sent successfully"
      });
    } catch (err) {
      console.log(err);
      next(err);
    }
  };

  export { sendSMS }